const express = require('express');
// const lighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Store for ongoing audits (in production, use Redis or database)
const auditQueue = new Map();

// Lighthouse configuration for accessibility only
const lighthouseConfig = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['accessibility'],
    skipAudits: [
      'screenshot-thumbnails',
      'final-screenshot',
      'full-page-screenshot'
    ]
  }
};

// Dynamic import for lighthouse (ESM module)
let lighthouse;
async function loadLighthouse() {
  if (!lighthouse) {
    try {
      // Try CommonJS require first
      lighthouse = require('lighthouse');
      if (typeof lighthouse !== 'function' && lighthouse.default) {
        lighthouse = lighthouse.default;
      }
    } catch (e) {
      // Fallback to dynamic import for ESM
      const lighthouseModule = await import('lighthouse');
      lighthouse = lighthouseModule.default || lighthouseModule.lighthouse;
    }
  }
  return lighthouse;
}

// Function to run accessibility audit
async function runAccessibilityAudit(url) {
  let chrome;
  try {
    // Launch Chrome
    chrome = await chromeLauncher.launch({
      chromeFlags: ['--headless', '--no-sandbox', '--disable-dev-shm-usage']
    });

    // Run Lighthouse audit
    // const runnerResult = await lighthouse(url, {
    //   port: chrome.port,
    //   output: 'json'
    // }, lighthouseConfig);

    // const report = runnerResult.lhr;

     // Load lighthouse dynamically
     const lighthouseFunc = await loadLighthouse();
      
     if (typeof lighthouseFunc !== 'function') {
       throw new Error('Lighthouse function not found. Make sure lighthouse is installed. run `npm install lighthouse@latest`')
     }

     // Enhanced lighthouse configuration
     const config = {
       port: chrome.port,
       output: 'json',
       onlyCategories: ['accessibility'],
       settings: {
         maxWaitForFcp: 15 * 1000,
         maxWaitForLoad: 35 * 1000,
         pauseAfterFcpMs: 1000,
         pauseAfterLoadMs: 1000,
         networkQuietThresholdMs: 1000,
         cpuQuietThresholdMs: 1000
       },
       // Disable problematic audits that can cause timing issues
       skipAudits: [
         'screenshot-thumbnails',
         'final-screenshot'
       ]
     };

     const result = await lighthouseFunc(url, config);
     const report = result.lhr;
    
    // Extract accessibility-specific data
    const accessibilityScore = report.categories.accessibility.score * 100;
    const accessibilityAudits = report.categories.accessibility.auditRefs.map(ref => {
      const audit = report.audits[ref.id];
      return {
        id: audit.id,
        title: audit.title,
        description: audit.description,
        score: audit.score,
        scoreDisplayMode: audit.scoreDisplayMode,
        details: audit.details,
        numericValue: audit.numericValue,
        displayValue: audit.displayValue
      };
    });

    // Categorize issues
    const failedAudits = accessibilityAudits.filter(audit => 
      audit.score !== null && audit.score < 1
    );
    const passedAudits = accessibilityAudits.filter(audit => 
      audit.score === 1
    );
    const manualAudits = accessibilityAudits.filter(audit => 
      audit.scoreDisplayMode === 'manual'
    );

    return {
      url,
      timestamp: new Date().toISOString(),
      overallScore: Math.round(accessibilityScore),
      summary: {
        totalAudits: accessibilityAudits.length,
        passed: passedAudits.length,
        failed: failedAudits.length,
        manual: manualAudits.length
      },
      failedAudits,
      passedAudits,
      manualAudits,
      rawLighthouseData: report
    };

  } finally {
    if (chrome) {
      await chrome.kill();
    }
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/audit', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const auditId = Date.now().toString();
  auditQueue.set(auditId, { status: 'running', url });

  // Start audit in background
  runAccessibilityAudit(url)
    .then(result => {
      auditQueue.set(auditId, { status: 'completed', result });
    })
    .catch(error => {
      console.error('Audit failed:', error);
      auditQueue.set(auditId, { 
        status: 'failed', 
        error: error.message || 'Audit failed' 
      });
    });

  res.json({ auditId, status: 'started' });
});

app.get('/audit/:id', (req, res) => {
  const auditId = req.params.id;
  const audit = auditQueue.get(auditId);
  
  if (!audit) {
    return res.status(404).json({ error: 'Audit not found' });
  }
  
  res.json(audit);
});

app.get('/report/:id', async (req, res) => {
  const auditId = req.params.id;
  const audit = auditQueue.get(auditId);
  
  if (!audit || audit.status !== 'completed') {
    return res.status(404).json({ error: 'Report not available' });
  }
  
  // Generate HTML report
  const htmlReport = generateAccessibilityReport(audit.result);
  res.setHeader('Content-Type', 'text/html');
  res.send(htmlReport);
});

// Function to generate HTML report
function generateAccessibilityReport(auditResult) {
  const { url, timestamp, overallScore, summary, failedAudits, passedAudits, manualAudits } = auditResult;
  
  const getScoreColor = (score) => {
    if (score >= 90) return '#0CCE6B';
    if (score >= 50) return '#FFA400';
    return '#FF4E42';
  };

  const formatAuditItem = (audit) => {
    const icon = audit.score === 1 ? '✅' : 
                 audit.score === 0 ? '❌' : 
                 audit.scoreDisplayMode === 'manual' ? '⚠️' : '❓';
    
    // Better formatting for different types of audit details
    const formatIssueDetails = (audit) => {
      if (!audit.details || !audit.details.items || audit.details.items.length === 0) {
        return '';
      }

      const items = audit.details.items.slice(0, 10); // Show up to 10 items
      
      return `
        <div class="audit-details">
          <strong>Issues found (${audit.details.items.length} total):</strong>
          <div class="issues-list">
            ${items.map((item, index) => {
              // Handle different types of issue items
              let issueText = '';
              let sourceInfo = '';
              
              if (item.node) {
                // DOM node issues
                issueText = item.node.nodeLabel || item.node.snippet || 'Element found';
                if (item.node.path) {
                  sourceInfo = `<div class="source-path">Path: ${item.node.path}</div>`;
                }
                if (item.node.selector) {
                  sourceInfo += `<div class="css-selector">Selector: <code>${item.node.selector}</code></div>`;
                }
              } else if (item.source) {
                // Source-based issues (like missing alt text)
                issueText = item.source.snippet || item.source.url || 'Issue detected';
                if (item.source.line !== undefined) {
                  sourceInfo = `<div class="source-line">Line ${item.source.line}</div>`;
                }
              } else if (typeof item === 'string') {
                issueText = item;
              } else if (item.text) {
                issueText = item.text;
              } else if (item.description) {
                issueText = item.description;
              } else {
                // Fallback for other item types
                issueText = Object.values(item).find(val => 
                  typeof val === 'string' && val.length > 0 && val.length < 200
                ) || 'Issue detected';
              }
              
              return `
                <div class="issue-item">
                  <div class="issue-content">
                    <div class="issue-text">${escapeHtml(issueText)}</div>
                    ${sourceInfo}
                  </div>
                </div>
              `;
            }).join('')}
            ${audit.details.items.length > 10 ? 
              `<div class="more-issues">... and ${audit.details.items.length - 10} more issues</div>` : ''
            }
          </div>
        </div>
      `;
    };
    
    return `
      <div class="audit-item ${audit.score === 1 ? 'passed' : audit.score === 0 ? 'failed' : 'manual'}">
        <div class="audit-header">
          <span class="audit-icon">${icon}</span>
          <h4>${audit.title}</h4>
        </div>
        <p class="audit-description">${audit.description}</p>
        ${formatIssueDetails(audit)}
      </div>
    `;
  };

  // Helper function to escape HTML
  const escapeHtml = (text) => {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Accessibility Audit Report</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1000px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { padding: 30px; border-bottom: 1px solid #eee; text-align: center; }
        .score-circle { width: 120px; height: 120px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 32px; font-weight: bold; color: white; margin: 20px 0; }
        .url-info { margin: 20px 0; }
        .url { color: #666; margin: 5px 0; word-break: break-all; font-size: 16px; }
        .url-label { font-weight: 600; color: #333; }
        .timestamp { color: #999; font-size: 14px; }
        .summary { display: flex; justify-content: space-around; padding: 20px; background: #f9f9f9; }
        .summary-item { text-align: center; }
        .summary-number { font-size: 24px; font-weight: bold; }
        .summary-label { color: #666; font-size: 14px; }
        .section { padding: 30px; }
        .section h2 { color: #333; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        .audit-item { margin: 20px 0; padding: 20px; border: 1px solid #eee; border-radius: 6px; }
        .audit-item.failed { border-left: 4px solid #FF4E42; }
        .audit-item.passed { border-left: 4px solid #0CCE6B; }
        .audit-item.manual { border-left: 4px solid #FFA400; }
        .audit-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .audit-icon { font-size: 18px; }
        .audit-header h4 { margin: 0; color: #333; }
        .audit-description { color: #666; margin: 10px 0; }
        .audit-details { margin-top: 15px; padding: 15px; background: #f9f9f9; border-radius: 4px; }
        .issues-list { margin-top: 10px; }
        .issue-item { margin: 10px 0; padding: 12px; background: white; border-radius: 4px; border-left: 3px solid #e5e7eb; }
        .issue-item:hover { border-left-color: #6366f1; }
        .issue-text { font-weight: 500; color: #374151; margin-bottom: 5px; }
        .source-path, .source-line, .css-selector { font-size: 12px; color: #6b7280; margin: 2px 0; }
        .css-selector code { background: #f3f4f6; padding: 2px 4px; border-radius: 2px; font-family: 'SF Mono', Monaco, monospace; }
        .more-issues { margin-top: 10px; padding: 8px; background: #f3f4f6; border-radius: 4px; font-style: italic; color: #6b7280; text-align: center; }
        .no-issues { text-align: center; color: #666; padding: 40px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Accessibility Audit Report</h1>
          <div class="score-circle" style="background-color: ${getScoreColor(overallScore)}">
            ${overallScore}
          </div>
          <div class="url-info">
            <div class="url-label">Scanned URL:</div>
            <div class="url">${url}</div>
          </div>
          <div class="timestamp">Generated on ${new Date(timestamp).toLocaleString()}</div>
        </div>
        
        <div class="summary">
          <div class="summary-item">
            <div class="summary-number" style="color: #0CCE6B">${summary.passed}</div>
            <div class="summary-label">Passed</div>
          </div>
          <div class="summary-item">
            <div class="summary-number" style="color: #FF4E42">${summary.failed}</div>
            <div class="summary-label">Failed</div>
          </div>
          <div class="summary-item">
            <div class="summary-number" style="color: #FFA400">${summary.manual}</div>
            <div class="summary-label">Manual Review</div>
          </div>
        </div>

        ${failedAudits.length > 0 ? `
          <div class="section">
            <h2>❌ Failed Audits (${failedAudits.length})</h2>
            ${failedAudits.map(formatAuditItem).join('')}
          </div>
        ` : ''}

        ${manualAudits.length > 0 ? `
          <div class="section">
            <h2>⚠️ Manual Review Required (${manualAudits.length})</h2>
            ${manualAudits.map(formatAuditItem).join('')}
          </div>
        ` : ''}

        ${passedAudits.length > 0 ? `
          <div class="section">
            <h2>✅ Passed Audits (${passedAudits.length})</h2>
            ${failedAudits.length === 0 ? passedAudits.map(formatAuditItem).join('') : 
              '<div class="no-issues">All passed audits are working correctly! 🎉</div>'}
          </div>
        ` : ''}
      </div>
    </body>
    </html>
  `;
}

app.listen(PORT, () => {
  console.log(`Accessibility Audit Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to start auditing websites`);
});

module.exports = app;