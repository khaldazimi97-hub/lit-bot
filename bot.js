const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const http = require('http'); // ماژول ساخته شده در نود جی‌اس (بدون نصب اضافی)

// --- تنظیمات ---
const LINK_REGEX = /(https?:\/\/[^\s]+)/g;
const MAX_VIOLATIONS = 2; 
const SESSION_ID = 'session';
const PORT = process.env.PORT || 3000; // پورت رندر یا پیش‌فرض

// --- پیام معرفی ---
const BOT_INTRO = `🤖✨ سلام! من ربات چندمنظوره AI LAB هستم

🚀 ساخته‌شده برای مدیریت هوشمند گروه‌ها و کانال‌ها

🔥 قابلیت‌ها:
🛡️ ادمین قدرتمند ضد لینک
🚫 حذف خودکار لینک‌های مزاحم
📢 لینک‌زن انبوه سریع و بدون دردسر
⚡ سبک، سریع و همیشه آماده

📌 مناسب برای گروپ‌ها و کانال‌های حرفه‌ای

📣 کانال سازنده:
👉 https://whatsapp.com/channel/0029VbCJeAJFi8xgTpJB412M

💡 با AI LAB مدیریت رو بسپار به هوش مصنوعی!`;

// --- حافظه موقت ---
const userLinkCounts = {};
const groupAdmins = {};

const logger = pino({ level: 'silent' });

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_ID);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        defaultQueryTimeoutMs: undefined,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // --- مدیریت اتصال و QR ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('-------------------------------------------');
            console.log('📲 Scan this QR Code:');
            console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
            console.log('-------------------------------------------');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.clear();
            console.log('✅ Bot Connected!');
        }
    });

    // --- مدیریت گروه ---
    sock.ev.on('group-participants.update', async (data) => {
        const { id: groupJid, participants, action } = data;
        if (groupAdmins[groupJid]) {
            delete groupAdmins[groupJid];
        }
        if (action === 'promote' && participants.includes(sock.user.id)) {
            await sock.sendMessage(groupJid, { text: BOT_INTRO });
            console.log(`Bot promoted in group. Sent intro message.`);
        }
    });

    // --- مدیریت پیام‌ها ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            const senderJid = msg.key.participant || msg.key.remoteJid;

            if (!remoteJid.endsWith('@g.us')) continue;

            const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            if (!LINK_REGEX.test(messageContent)) continue;

            const isAdmin = await checkIsAdmin(sock, remoteJid, senderJid);
            if (isAdmin) continue;

            await sock.sendMessage(remoteJid, { delete: msg.key });
            console.log(`🗑️ Deleted link from: ${senderJid.split('@')[0]}`);

            const currentCount = (userLinkCounts[senderJid] || 0) + 1;
            userLinkCounts[senderJid] = currentCount;

            if (currentCount >= MAX_VIOLATIONS) {
                console.log(`🔴 Removing user: ${senderJid.split('@')[0]}`);
                try {
                    await sock.groupParticipantsUpdate(remoteJid, [senderJid], "remove");
                    delete userLinkCounts[senderJid];
                } catch (e) {
                    console.error("Error removing user:", e);
                }
            }
        }
    });
}

async function checkIsAdmin(sock, groupJid, userJid) {
    if (!groupAdmins[groupJid] || groupAdmins[groupJid].length === 0) {
        try {
            const metadata = await sock.groupMetadata(groupJid);
            groupAdmins[groupJid] = metadata.participants
                .filter(p => p.admin !== null)
                .map(p => p.id);
        } catch (e) {
            return false;
        }
    }
    return groupAdmins[groupJid].includes(userJid);
}

// --- راه‌اندازی سرور وب برای UptimeRobot ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive'); // این پاسخ به UptimeRobot می‌دهد
});

server.listen(PORT, () => {
    console.log(`HTTP Server running on port ${PORT}`);
    startBot(); // شروع بات بعد از روشن شدن سرور
});
