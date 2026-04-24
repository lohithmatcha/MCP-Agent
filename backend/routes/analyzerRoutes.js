// backend/routes/analyzerRoutes.js
const express = require("express");
const router = express.Router();
const analyzer = require("../controllers/analyzerController");
//const { generateLLMExplanation } = require("../utils/llmExplain");

router.post("/analyze", analyzer.analyzePackage);
router.get("/ai-explain", analyzer.getAIExplanation);

module.exports = router;
