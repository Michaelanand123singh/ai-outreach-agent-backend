const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Create public directory if it doesn't exist
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Create python directory if it doesn't exist
const pythonDir = path.join(__dirname, 'python');
if (!fs.existsSync(pythonDir)) {
  fs.mkdirSync(pythonDir, { recursive: true });
}

// Ensure the Python script exists in the python directory
const pythonScriptPath = path.join(pythonDir, 'ai_agent.py');
if (!fs.existsSync(pythonScriptPath)) {
  const sourceScriptPath = path.join(__dirname, 'ai_agent.py');
  if (fs.existsSync(sourceScriptPath)) {
    fs.copyFileSync(sourceScriptPath, pythonScriptPath);
  } else {
    console.error('Python script not found. Make sure ai_agent.py exists in your repository.');
  }
}

// ✅ Corrected allowedOrigins (no trailing slash)
const allowedOrigins = [
  'http://localhost:3000',
  'https://ai-outreach-agent-frontend.vercel.app'
];

// ✅ CORS middleware
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true
}));

app.use(express.json());
app.use(express.static('public', {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.xlsx')) {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
  }
}));

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, __dirname);
  },
  filename: (req, file, cb) => {
    cb(null, 'uploaded_file.xlsx');
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') {
      return cb(new Error('Only Excel files are allowed'));
    }
    cb(null, true);
  },
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

// Endpoint to process uploaded Excel file
app.post('/api/process', upload.single('excelFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  console.log(`Excel file uploaded: ${req.file.originalname}`);

  const pythonProcess = spawn('python', [
    path.join(__dirname, 'python', 'ai_agent.py'),
    path.join(__dirname, 'uploaded_file.xlsx'),
    path.join(__dirname, 'public', 'outreach_results.xlsx')
  ]);

  let pythonData = '';
  let pythonError = '';

  pythonProcess.stdout.on('data', (data) => {
    pythonData += data.toString();
    console.log(`Python stdout: ${data}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    pythonError += data.toString();
    console.error(`Python stderr: ${data}`);
  });

  pythonProcess.on('close', (code) => {
    console.log(`Python process exited with code ${code}`);

    if (code !== 0) {
      return res.status(500).json({
        message: 'Error processing the file',
        error: pythonError
      });
    }

    let pythonResults = { processedCount: 0, contactsFound: 0 };

    try {
      const jsonStartIdx = pythonData.indexOf('{');
      const jsonEndIdx = pythonData.lastIndexOf('}');
      if (jsonStartIdx !== -1 && jsonEndIdx !== -1) {
        const jsonStr = pythonData.substring(jsonStartIdx, jsonEndIdx + 1);
        pythonResults = JSON.parse(jsonStr);
      }
    } catch (err) {
      console.error('Error parsing Python output:', err);
    }

    const outputFilePath = path.join(__dirname, 'public', 'outreach_results.xlsx');
    if (!fs.existsSync(outputFilePath)) {
      return res.status(500).json({
        message: 'Output file not generated',
        error: pythonError || 'Unknown error'
      });
    }

    return res.json({
      message: 'File processed successfully',
      fileUrl: '/api/download',
      processedCount: pythonResults.processedCount || 0,
      contactsFound: pythonResults.contactsFound || 0
    });
  });
});

// File download endpoint
app.get('/api/download', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'outreach_results.xlsx');

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: 'File not found' });
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=outreach_results.xlsx');
  res.setHeader('Content-Length', fs.statSync(filePath).size);

  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
});

// Health check endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'Server is running',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
