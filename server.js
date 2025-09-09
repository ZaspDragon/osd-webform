import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";

dotenv.config();

const app = express();

// CORS (lock to your site in production via FRONTEND_ORIGIN)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: FRONTEND_ORIGIN, methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "20mb" })); // base64 photos/signature allowed

// Helpers
function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!m) return null;
  return Buffer.from(m[2], "base64");
}
function parseEmails(str, fallback = []) {
  if (!str) return fallback;
  return String(str).split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
}
function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,           // smtp.sendgrid.net
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER,   // "apikey"
            pass: process.env.SMTP_PASS }, // SG.XXXX
  });
}

// Health
app.get("/", (_req, res) => res.send("OSD backend is up"));

// PDF builder
async function buildPdfBuffer(payload) {
  const {
    timestamp, location, loadId, poNumber, trailerNumber, stopNumber,
    carrier, vendorId, vendorName, notes, driverName, proNumber,
    signatureDataUrl, photos = [], toEmail, ccEmail, bccEmail
  } = payload || {};

  const toList  = parseEmails(toEmail);
  const ccList  = parseEmails(ccEmail);
  const bccList = parseEmails(bccEmail);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("OSD – Driver Sign-Off", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#555")
      .text(`Generated: ${new Date().toLocaleString()}`, { align: "right" })
      .fillColor("black");
    doc.moveDown();

    const leftX = doc.x, colGap = 280;
    const line = (label, val, x = leftX) => {
      doc.font("Helvetica-Bold").text(`${label}: `, x, doc.y, { continued: true });
      doc.font("Helvetica").text(String(val ?? ""), { width: 250 });
    };

    const startY = doc.y;
    line("Date/Time", timestamp);
    line("Location", location);
    line("Load ID / BOL #", loadId);
    line("PO Number", poNumber);
    line("Trailer #", trailerNumber);
    line("Stop #", stopNumber);

    line("Carrier",    carrier,   leftX + colGap);
    line("Vendor ID",  vendorId,  leftX + colGap);
    line("Vendor Name",vendorName,leftX + colGap);
    line("Driver Name",driverName,leftX + colGap);
    line("PRO #",      proNumber, leftX + colGap);

    doc.moveDown();

    // recipients in PDF (clickable)
    const mailLine = (label, arr) => {
      doc.font("Helvetica-Bold").text(`${label}: `);
      if (!arr.length) { doc.font("Helvetica").text("—"); return; }
      arr.forEach(addr => {
        doc.fillColor("#1d4ed8").text(addr, { link:`mailto:${addr}`, underline:true }).fillColor("black");
      });
      doc.moveDown(0.3);
    };
    doc.fontSize(12);
    mailLine("Email To", toList);
    mailLine("CC", ccList);
    mailLine("BCC", bccList);

    // notes
    doc.font("Helvetica-Bold").text("Notes / Exceptions");
    doc.font("Helvetica").text(notes || "—");
    doc.moveDown();

    // signature block
    const sigBuf = dataUrlToBuffer(signatureDataUrl);
    if (sigBuf) {
      doc.font("Helvetica-Bold").text("Driver Signature");
      doc.moveDown(0.3);
      const sigW = 380, sigH = 120;
      const x = doc.x, y = doc.y;
      doc.save().rect(x - 2, y - 2, sigW + 4, sigH + 4).stroke("#ddd").restore();
      try { doc.image(sigBuf, x, y, { fit:[sigW, sigH], align:"left", valign:"center" }); } catch (e) {}
      doc.moveDown(2);
    }

    // photos grid (max 12)
    const safePhotos = Array.isArray(photos) ? photos.slice(0,12) : [];
    if (safePhotos.length > 0) {
      doc.font("Helvetica-Bold").text("Photos");
      doc.moveDown(0.5);

      const cellW = 160, cellH = 120, gap = 12;
      let x = doc.x, rowY = doc.y, col = 0;

      for (const p of safePhotos) {
        let b = null;
        try {
          const m = p && p.dataUrl ? p.dataUrl.match(/^data:(.+?);base64,(.+)$/) : null;
          if (m) b = Buffer.from(m[2], "base64");
        } catch (e) { b = null; }

        if (col === 3) { col = 0; x = doc.x; rowY += cellH + gap; }
        if (rowY + cellH > doc.page.height - doc.page.margins.bottom) {
          doc.addPage(); rowY = doc.y; x = doc.x; col = 0;
        }

        doc.save(); doc.rect(x - 1, rowY - 1, cellW + 2, cellH + 2).stroke("#e5e7eb"); doc.restore();
        if (b) { try { doc.image(b, x, rowY, { fit:[cellW, cellH], align:"center", valign:"center" }); } catch (e) {} }

        const caption = (p && p.name ? String(p.name) : "").slice(0,24);
        doc.fontSize(9).fillColor("#555").text(caption, x, rowY + cellH + 2, { width:cellW, align:"center" }).fillColor("black");

        x += cellW + gap; col += 1;
      }
      doc.moveDown();
    }

    doc.end();
  });
}

// API
app.post("/api/signoff", async (req, res) => {
  try {
    const body = req.body || {};
    const pdfBuffer = await buildPdfBuffer(body);

    const to  = parseEmails(body.toEmail, parseEmails(process.env.TO_EMAIL));
    const cc  = parseEmails(body.ccEmail);
    const bcc = parseEmails(body.bccEmail);

    if (!to.length) return res.status(400).json({ ok:false, error:"No recipient (toEmail or TO_EMAIL)." });

    const subject  = body.subject?.trim() || `OSD Sign-Off${body.poNumber ? ` – ${body.poNumber}` : ""}`;
    const textBody = body.message?.trim() || "Attached: OSD sign-off PDF.";

    const transporter = makeTransport();
    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to,
      cc:  cc.length  ? cc  : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject,
      text: textBody,
      attachments: [{ filename: "osd-signoff.pdf", content: pdfBuffer }],
    });

    res.json({ ok:true, id: Date.now().toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error: err.message || "Server error" });
  }
});

// start (Render)
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => console.log(`Server running on ${port}`));
