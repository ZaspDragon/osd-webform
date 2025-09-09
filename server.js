import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

dotenv.config();

// __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Allow your frontend origin (set this in Render > Environment)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: '20mb' }));

// Optional: save a copy of submissions on disk
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'submissions');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Health route (Render checks this)
app.get('/', (req, res) => res.send('OSD backend is up'));

// ---- PDF helper ----
function buildPdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('OSD – Driver Sign-Off', { underline: true });
    doc.moveDown();

    const rows = [
      ['Date/Time', data.timestamp],
      ['Location', data.location],
      ['Load ID / BOL #', data.loadId],
      ['PO Number', data.poNumber],
      ['Trailer #', data.trailerNumber],
      ['Stop #', data.stopNumber],
      ['Driver Name', data.driverName],
      ['Initials / Signature', data.driverInitials],
      ['Notes', data.notes],
    ];

    rows.forEach(([k, v]) => {
      doc.fontSize(12).text(`${k}: ${v ?? ''}`);
    });

    // If you send base64 photos later, you can embed them here.
    doc.end();
  });
}

// ---- Email helper ----
function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ---- API: receive form, make PDF, email it ----
app.post('/api/signoff', async (req, res) => {
  try {
    const data = req.body || {};
    const id = uuidv4();

    // 1) Build PDF
    const pdfBuffer = await buildPdfBuffer(data);

    // 2) Optional: save a copy on disk
    try {
      const folder = path.join(OUT_DIR, id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'submission.json'), JSON.stringify(data, null, 2));
      fs.writeFileSync(path.join(folder, 'osd-signoff.pdf'), pdfBuffer);
    } catch (e) {
      // saving is optional; don't fail the request for this
      console.warn('Save-to-disk warning:', e.message);
    }

    // 3) Email it
    const transporter = makeTransport();
    const toEmail = data.toEmail || process.env.TO_EMAIL;
    if (!toEmail) {
      return res.status(400).json({ ok: false, error: 'No recipient email (toEmail or TO_EMAIL env).' });
    }

    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: toEmail,
      subject: `OSD Sign-Off ${data.poNumber ? `– ${data.poNumber}` : ''}`,
      text: 'Attached: OSD sign-off PDF.',
      attachments: [{ filename: 'osd-signoff.pdf', content: pdfBuffer }],
    });

    res.json({ ok: true, id, message: 'PDF generated and emailed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// ---- Start server (Render must use process.env.PORT) ----
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
