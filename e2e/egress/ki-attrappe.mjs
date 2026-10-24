// Stellvertreter für einen KI-Anbieter im Test (öffentlich aussehende Adresse 11.22.33.10 in einem Docker-Netz).
// HTTPS auf 443 mit selbst signiertem Zertifikat (ATTRAPPE_CERT, ATTRAPPE_KEY), HTTP auf 80.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';

const antwort = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', attrappe: true, data: [{ id: 'attrappe-chat', object: 'model' }], pfad: req.url }));
};
https.createServer({ cert: fs.readFileSync(process.env.ATTRAPPE_CERT), key: fs.readFileSync(process.env.ATTRAPPE_KEY) }, antwort).listen(443, '0.0.0.0');
http.createServer(antwort).listen(80, '0.0.0.0');
console.log('ki-attrappe bereit');
