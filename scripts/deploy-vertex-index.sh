#!/bin/bash
# 1. Create the Streaming Index for Real-Time Memory
gcloud ai indexes create \
  --display-name="similarities" \
  --description="768-dim streaming index for creative gap analysis" \
  --index-update-method="STREAM_UPDATE" \
  --dimensions=768 \
  --distance-measure-type="DOT_PRODUCT_DISTANCE"

# 2. Provision the Index Endpoint (The API Gateway)
gcloud ai index-endpoints create \
  --display-name="similaritiesEndpoint" \
  --public-endpoint-enabled

# 3. Deploy the Index to the Endpoint
# This handles the "Last Mile" connectivity for the MatchServiceClient
gcloud ai index-endpoints deploy-index \
  --index-endpoint=$ENDPOINT_ID \
  --deployed-index-id="similaritiesDeployment" \
  --index=$INDEX_ID