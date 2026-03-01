const { MatchServiceClient, IndexServiceClient, PredictionServiceClient } =
  require("@google-cloud/aiplatform").v1;
const { helpers } = require("@google-cloud/aiplatform");

// Initialize Vertex AI Clients
const indexClient = new IndexServiceClient({
  apiEndpoint: "us-central1-aiplatform.googleapis.com",
});

const matchClient = new MatchServiceClient({
  apiEndpoint: process.env.API_ENDPOINT, // Required for findNeighbors
});

const predictionClient = new PredictionServiceClient({
  apiEndpoint: "us-central1-aiplatform.googleapis.com",
});

class VectorSearchService {
  /**
   * Helper to generate embedding using Vertex AI
   * @param {string} text
   */
  async generateEmbedding(text) {
    // Requires INDEX_RESOURCE_NAME environment variable (projects/.../locations/.../indexes/...)
    // or explicit GOOGLE_CLOUD_PROJECT + LOCATION
    const indexResourceName = process.env.INDEX_RESOURCE_NAME || "";
    let projectId, location;

    // Try to extract from resource name
    const match = indexResourceName.match(
      /projects\/([^/]+)\/locations\/([^/]+)/,
    );
    if (match) {
      projectId = match[1];
      location = match[2];
    } else {
      projectId = process.env.GOOGLE_CLOUD_PROJECT;
      location = process.env.LOCATION || "us-central1";
    }

    if (!projectId) {
      throw new Error(
        "Project ID not found. Set INDEX_RESOURCE_NAME or GOOGLE_CLOUD_PROJECT.",
      );
    }

    const endpoint = `projects/${projectId}/locations/${location}/publishers/google/models/text-embedding-004`;

    const instance = {
      content: text,
      task_type: "SEMANTIC_SIMILARITY",
    };
    const instanceValue = helpers.toValue(instance);

    const parameter = {
      outputDimensionality: 768,
    };
    const parameterValue = helpers.toValue(parameter);

    const [response] = await predictionClient.predict({
      endpoint,
      instances: [instanceValue],
      parameters: parameterValue,
    });

    const predictions = response.predictions;
    if (predictions.length === 0) {
      throw new Error("No predictions returned");
    }

    const embedding = helpers.fromValue(predictions[0]).embeddings;
    return embedding.values;
  }

  /**
   * Check for similarities against existing albums
   * @param {string} title
   * @param {string} genre
   * @param {string} description
   * @returns {Object} { status, reason, score }
   */
  /**
   * Quantifies creative novelty by cross-referencing new concepts
   * against the entire 768-dim repertoire in Vertex AI.
   */
  async similaritiesCheck(title, genre, description) {
    try {
      console.log(`Checking similarities for: ${title}`);
      const textToEmbed = `Title: ${title}. Genre: ${genre}. Description: ${description}`;

      // 1. Generate the embedding to match the Streaming Index config
      const vector = await this.generateEmbedding(textToEmbed);

      // 2. Load Environment Config
      const indexEndpoint = process.env.INDEX_ENDPOINT;
      const deployedIndexId = process.env.DEPLOYED_INDEX_ID;

      if (!indexEndpoint || !deployedIndexId) {
        console.warn(
          "INDEX_ENDPOINT or DEPLOYED_INDEX_ID not set. Returning mock result.",
        );
        return {
          status: "ACCEPT",
          reason: "Vector Search not configured.",
          score: 0,
        };
      }

      // 3. Construct the search request
      const request = {
        indexEndpoint: indexEndpoint,
        deployedIndexId: deployedIndexId,
        queries: [
          {
            datapoint: { featureVector: vector },
            neighborCount: 5,
          },
        ],
      };

      const [response] = await matchClient.findNeighbors(request);

      const neighbors = response.nearestNeighbors;
      if (
        !neighbors ||
        neighbors.length === 0 ||
        !neighbors[0].neighbors ||
        neighbors[0].neighbors.length === 0
      ) {
        return {
          status: "ACCEPT",
          reason: "No similar albums found. Complete creative freedom!",
          score: 0,
        };
      }

      const closestMatch = neighbors[0].neighbors[0]; // Top 1 hit
      const distance = closestMatch.distance || 0;

      console.log(
        `Closest match ID: ${closestMatch.datapoint?.datapointId}, Score: ${distance}`,
      );

      if (distance > 0.8) {
        return {
          status: "REJECT",
          reason: "Theme too similar to existing repertoire.",
          score: distance,
        };
      }

      const isGap = distance < 0.4;

      return {
        status: "ACCEPT",
        reason: isGap
          ? "Unique creative gap identified!"
          : "Standard variation within genre.",
        score: distance,
      };
    } catch (error) {
      console.error("Error checking similarities:", error);
      throw error;
    }
  }
}

module.exports = new VectorSearchService();
