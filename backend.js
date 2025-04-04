const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const { initializeApp, credential, storage } = require('firebase-admin');
const axios = require('axios');
const dotenv = require('dotenv');
const torch = require('@tensorflow/tfjs-node');  // TensorFlow.js for Node.js
const { BertTokenizer, BertForSequenceClassification } = require('transformers');  // TensorFlow.js equivalent for Huggingface
dotenv.config();

// Initialize Firebase Admin SDK
initializeApp({
  credential: credential.cert(path.join(__dirname, 'path/to/firebase-credentials.json')),
  storageBucket: 'your-project-id.appspot.com',
});

const app = express();
const UPLOAD_FOLDER = 'uploads';
const ALLOWED_EXTENSIONS = ['ris', 'nbib'];

if (!fs.existsSync(UPLOAD_FOLDER)) {
  fs.mkdirSync(UPLOAD_FOLDER);
}

// Initialize BERT model and tokenizer
const modelName = 'bert-base-uncased';
const bertModel = BertForSequenceClassification.from_pretrained(modelName, { num_labels: 3 });
const bertTokenizer = BertTokenizer.from_pretrained(modelName);

console.log("BERT model loaded successfully.");

// Function to check file extension
function allowedFile(filename) {
  return filename && ALLOWED_EXTENSIONS.includes(filename.split('.').pop().toLowerCase());
}

// Function to get BERT embeddings
async function getBertEmbeddings(texts) {
  const inputs = bertTokenizer(texts, { padding: true, truncation: true, return_tensors: 'pt', max_length: 512 });
  const outputs = await bertModel(inputs);
  return outputs.logits;
}

// Function to create AI payload
function createPayload(embedding) {
  return JSON.stringify({
    messages: [{ role: 'user', content: JSON.stringify(embedding.tolist()) }]
  });
}

// Function to call AI API
async function callAiApi(url, headers, payload) {
  try {
    const response = await axios.post(url, payload, { headers, timeout: 75000 });
    return response.data;
  } catch (error) {
    console.error('API error:', error.message);
    return { error: 'Failed after multiple retries' };
  }
}

// Middleware to handle file uploads
app.use(fileUpload());

// File upload route
app.post('/upload', async (req, res) => {
  const files = req.files;
  if (!files || !files.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const uploadedFiles = Array.isArray(files.file) ? files.file : [files.file];
  const aiResults = [];

  for (const file of uploadedFiles) {
    if (allowedFile(file.name)) {
      const filepath = path.join(UPLOAD_FOLDER, file.name);
      
      // Save the uploaded file
      fs.writeFileSync(filepath, file.data);

      try {
        const lines = fs.readFileSync(filepath, 'utf-8').split('\n');
        const citations = lines.filter(line => line.startsWith('TI - ')).map(line => line.slice(5).trim());

        if (citations.length === 0) {
          return res.status(400).json({ success: false, message: 'No valid citations found' });
        }

        // Process citations with BERT
        const embeddings = await getBertEmbeddings(citations);

        // Upload file to Firebase Storage
        const bucket = storage().bucket();
        const blob = bucket.file(`uploads/${file.name}`);
        await blob.save(file.data);

        // Prepare API requests
        const API_KEY = process.env.AI_API_KEY;
        const API_URL = process.env.AI_API_URL;

        const headers = {
          'apikey': API_KEY,
          'Content-Type': 'application/json'
        };

        for (const embedding of embeddings) {
          const payload = createPayload(embedding);
          const response = await callAiApi(API_URL, headers, payload);

          if (response.error) {
            aiResults.push({ title: citations[i], classification: 'Error', ai_message: response.error });
          } else {
            const classification = response?.choices?.[0]?.message?.content || 'Unknown';
            aiResults.push({ title: citations[i], classification });
          }
        }
      } catch (error) {
        return res.status(500).json({ success: false, message: `Error processing file: ${error.message}` });
      }
    } else {
      return res.status(400).json({ success: false, message: 'Invalid file format' });
    }
  }

  return res.status(200).json({ success: true, results: aiResults });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
