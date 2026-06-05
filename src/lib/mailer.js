const nodemailer = require('nodemailer');

// Configuracion SMTP via variables de entorno.
// Si no estan definidas, el sistema NO envia correo real: registra el enlace en consola (modo desarrollo).
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true'; // true para puerto 465
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'no-reply@gestion-taller.local';

const smtpConfigurado = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

let transporter = null;
if (smtpConfigurado) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

/**
 * Envia el correo de recuperacion de contrasena.
 * @param {Object} opts
 * @param {string} opts.to        Correo destino
 * @param {string} opts.nombre    Nombre del usuario
 * @param {string} opts.enlace    URL completa de restablecimiento
 * @param {string} [opts.taller]  Nombre del taller (para el remitente/asunto)
 * @returns {Promise<{enviado:boolean, simulado:boolean}>}
 */
async function enviarRecuperacion({ to, nombre, enlace, taller }) {
  const nombreTaller = taller || 'Gestion Taller';
  const asunto = `Recuperacion de contrasena - ${nombreTaller}`;
  const texto = `Hola ${nombre || ''},\n\n` +
    `Recibimos una solicitud para restablecer tu contrasena en ${nombreTaller}.\n` +
    `Abre el siguiente enlace para crear una nueva contrasena (vence en 1 hora):\n\n` +
    `${enlace}\n\n` +
    `Si no solicitaste este cambio, puedes ignorar este correo.\n`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
      <h2 style="color:#0d6efd">${nombreTaller}</h2>
      <p>Hola <strong>${nombre || ''}</strong>,</p>
      <p>Recibimos una solicitud para restablecer tu contrasena.</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${enlace}" style="background:#0d6efd;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none">
          Restablecer contrasena
        </a>
      </p>
      <p style="color:#666;font-size:13px">Este enlace vence en 1 hora. Si no solicitaste el cambio, ignora este correo.</p>
      <p style="color:#999;font-size:12px;word-break:break-all">${enlace}</p>
    </div>`;

  if (!smtpConfigurado) {
    // Modo desarrollo: sin SMTP configurado, mostramos el enlace en el log.
    console.log('=================================================================');
    console.log('[mailer] SMTP no configurado. Enlace de recuperacion (modo dev):');
    console.log(`[mailer] Para: ${to}`);
    console.log(`[mailer] ${enlace}`);
    console.log('=================================================================');
    return { enviado: false, simulado: true };
  }

  await transporter.sendMail({ from: SMTP_FROM, to, subject: asunto, text: texto, html });
  return { enviado: true, simulado: false };
}

/**
 * Envia un correo generico (usado por ejemplo para mandar cotizaciones con PDF adjunto).
 * @param {Object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.text]
 * @param {string} [opts.html]
 * @param {Array}  [opts.attachments]  Adjuntos formato nodemailer: [{ filename, content (Buffer), contentType }]
 * @returns {Promise<{enviado:boolean, simulado:boolean}>}
 */
async function enviarCorreo({ to, subject, text, html, attachments }) {
  if (!smtpConfigurado) {
    console.log('=================================================================');
    console.log('[mailer] SMTP no configurado. Correo NO enviado (modo dev).');
    console.log(`[mailer] Para: ${to} | Asunto: ${subject}`);
    console.log('=================================================================');
    return { enviado: false, simulado: true };
  }
  await transporter.sendMail({ from: SMTP_FROM, to, subject, text, html, attachments });
  return { enviado: true, simulado: false };
}

module.exports = { enviarRecuperacion, enviarCorreo, smtpConfigurado };
