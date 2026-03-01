const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const vectorSearchService = require("./vector-search.cjs");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.post("/api/similarities", async (req, res) => {
  try {
    const { title, genre, description } = req.body;

    if (!title || !genre || !description) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const result = await vectorSearchService.similaritiesCheck(
      title,
      genre,
      description
    );
    res.json(result);
  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
