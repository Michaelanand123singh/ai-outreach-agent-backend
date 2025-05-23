const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const app = express();
const PORT = process.env.PORT || 5000;
const access = promisify(fs.access);

// Create required directories
const publicDir = path.join(__dirname, 'public');
const pythonDir = path.join(__dirname, 'python');

[publicDir, pythonDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Python script configuration
const pythonScriptPath = path.join(pythonDir, 'ai_agent.py');

// CORS Configuration
const allowedOrigins = [
  'http://localhost:3000',
  'https://ai-outreach-agent-frontend.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());

// Middleware
app.use(express.json());
app.use(express.static(publicDir));

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
    fileSize: 5 * 1024 * 1024 // 5MB
  }
});

// Process Excel File
app.post('/api/process', upload.single('excelFile'), async (req, res) => {
  try {
    // Verify Python script exists and is executable
    try {
      await access(pythonScriptPath, fs.constants.R_OK | fs.constants.X_OK);
    } catch (err) {
      console.error('Python script access error:', err);
      return res.status(500).json({
        message: 'Server configuration error',
        error: 'Python script not accessible'
      });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const inputPath = path.join(__dirname, 'uploaded_file.xlsx');
    const outputPath = path.join(publicDir, 'outreach_results.xlsx');

    console.log(`Starting Python process with: ${pythonScriptPath} ${inputPath} ${outputPath}`);

    const pythonProcess = spawn('python3', [
      pythonScriptPath,
      inputPath,
      outputPath
    ], {
      timeout: 300000 // 5 minute timeout
    });

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

    pythonProcess.on('error', (err) => {
      console.error('Python process error:', err);
      return res.status(500).json({
        message: 'Failed to start Python script',
        error: err.message
      });
    });

    pythonProcess.on('close', (code) => {
      console.log(`Python process exited with code ${code}`);

      if (code !== 0) {
        return res.status(500).json({
          message: 'Error processing file',
          error: pythonError || 'Python script failed'
        });
      }

      try {
        const outputExists = fs.existsSync(outputPath);
        if (!outputExists) {
          throw new Error('Output file not generated');
        }

        let results = { processedCount: 0, contactsFound: 0 };
        try {
          const jsonMatch = pythonData.match(/\{.*\}/);
          if (jsonMatch) results = JSON.parse(jsonMatch[0]);
        } catch (e) {
          console.warn('Could not parse Python output:', e);
        }

        return res.json({
          message: 'File processed successfully',
          fileUrl: '/api/download',
          ...results
        });
      } catch (err) {
        return res.status(500).json({
          message: 'Output generation failed',
          error: err.message
        });
      }
    });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({
      message: 'Internal server error',
      error: err.message
    });
  }
});

// Download Endpoint
app.get('/api/download', (req, res) => {
  try {
    const filePath = path.join(publicDir, 'outreach_results.xlsx');
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ 
        message: 'File not found',
        error: 'Results file does not exist'
      });
    }

    res.setHeader('Content-Type', 
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 
      'attachment; filename=outreach_results.xlsx');

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (err) {
    res.status(500).json({
      message: 'Download failed',
      error: err.message
    });
  }
});

// Health Check
app.get('/api/status', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    pythonScript: fs.existsSync(pythonScriptPath) ? 'Available' : 'Missing'
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Python script path: ${pythonScriptPath}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
});