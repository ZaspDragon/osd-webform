// server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';

dotenv.config();

const app = express();

// Allow your site to post (set this on Render -> Environment)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: '20mb' })); // accept photos/signature as base64

// --- Utilities ---
function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!m) return null;
  return Buffer.from(m[2], 'base64');
}

function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// Health
app.get('/', (_req, res) => res.send('OSD backend is up'));

// --- PDF builder: draws fields + signature + photos ---
async function buildPdfBuffer(payload) {
  const {
    timestamp, location, loadId, poNumber, trailerNumber, stopNumber,
    carrier, vendorId, vendorName, notes, driverName, proNumber,
    signatureDataUrl, photos = []
  } = payload || {};

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(20).text('OSD – Driver Sign-Off', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#555')
       .text(`Generated: ${new Date().toLocaleString()}`, { align: 'right' })
       .fillColor('black');
    doc.moveDown();

    // Two-column details
    const leftX = doc.x, colGap = 280;
    const line = (label, val, x = leftX, y) => {
      if (y !== undefined) doc.y = y;
      doc.font('Helvetica-Bold').text(`${label}: `, x, doc.y, { continued: true });
      doc.font('Helvetica').text(String(val ?? ''), { width: 250 });
    };

    const startY = doc.y;
    line('Date/Time', timestamp);
    line('Location', location);
    line('Load ID / BOL #', loadId);
    line('PO Number', poNumber);
    line('Trailer #', trailerNumber);
    line('Stop #', stopNumber);

    // Right column
    let y = startY;
    line('Carrier', carrier, leftX + colGap, y); y = doc.y;
    line('Vendor ID', vendorId, leftX + colGap); 
    line('Vendor Name', vendorName, leftX + colGap);
    line('Driver Name', driverName, leftX + colGap);
    line('PRO #', proNumber, leftX + colGap);

    doc.moveDown();

    // Notes
    doc.font('Helvetica-Bold').text('Notes / Exceptions');
    doc.font('Helvetica').text(notes || '—');
    doc.moveDown();

    // Signature
    const sigBuf = dataUrlToBuffer(signatureDataUrl);
    if (sigBuf) {
      doc.font('Helvetica-Bold').text('Driver Signature');
      doc.moveDown(0.3);
      const sigW = 380, sigH = 120;
      const x = doc.x, y = doc.y;
      // border
      doc.save().rect(x - 2, y - 2, sigW + 4, sigH + 4).stroke('#ddd').restore();
      // image (scaled to fit area)
      try { doc.image(sigBuf, x, y, { fit: [sigW, sigH], align: 'left', valign: 'center' }); }
      catch { /* ignore bad images */ }
      doc.moveDown( sigH / 14 ); // spacing after signature block
      doc.moveDown();
    }

    // Photos grid (thumbnails)
    const validPhotos = Array.isArray(photos) ? photos.slice(0, 12) : [];
    if (validPhotos.length) {
      doc.font('Helvetica-Bold').text('Photos');
      doc.moveDown(0.5);

      const cellW = 160, cellH = 120, gap = 12;
      let x = doc.x, rowY = doc.y, col = 0;

      for (const p of validPhotos) {
        const b = dataUrlToBuffer(p?.dataUrl);
        if (!b) continue;

        // Start new row if needed
        if (col === 3) { col = 0; x = doc.x; rowY += cellH + gap; }
        // New page if we’re too low
        if (rowY + cellH > doc.page.height - doc.page.margins.bottom) {
          doc.addPage(); rowY = doc.y; x = doc.x; col = 0;
        }

        // cell border
        doc.save().rect(x - 1, rowY - 1, cellW + 2, cellH + 2).stroke('#e5e7eb').restore();

        // image scaled to cell
        try { doc.image(b, x, rowY, { fit: [cellW, cellH], align: 'center', valign: 'center'] }); } catch {}
        // caption (filename) below
        const caption = (p?.name || '').slice(0, 24);
        doc.fontSize(9).fillColor('#555').text(caption, x, rowY + cellH + 2, { width: cellW, align: 'center' }).fillColor('black');

        x += cellW + gap; col += 1;
      }
    }

    doc.end();
  });
}

// --- API: receive submission, generate PDF, email ---
app.post('/api/signoff', async (req, res) => {
  try {
    const pdfBuffer = await buildPdfBuffer(req.body || {});
    const toEmail = req.body?.toEmail || process.env.TO_EMAIL;

    if (!toEmail) {
      return res.status(400).json({ ok: false, error: 'No recipient email (toEmail or TO_EMAIL).' });
    }

    const transporter = makeTransport();
    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: toEmail,
      subject: `OSD Sign-Off ${req.body?.poNumber ? `– ${req.body.poNumber}` : ''}`,
      text: 'Attached: OSD sign-off PDF.',
      attachments: [{ filename: 'osd-signoff.pdf', content: pdfBuffer }],
    });

    res.json({ ok: true, id: Date.now().toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// --- Start (Render) ---
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log(`Server running on ${port}`));
