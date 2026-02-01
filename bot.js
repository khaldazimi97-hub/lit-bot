const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode-terminal');

// --- تنظیمات ---
const LINK_REGEX = /(https?:\/\/[^\s]+)/g;
const MAX_VIOLATIONS = 2; // اخراج در دومین لینک
const SESSION_ID = 'session';

// --- پیام خوش‌آمدگویی / معرفی بات ---
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

// --- حافظه موقت (RAM) ---
const userLinkCounts = {};
const groupAdmins = {};

// --- لاگر ---
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

    // --- 1. مدیریت اتصال و نمایش QR ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.clear();
            console.log('Scan this QR Code with WhatsApp:');
            QRCode.generate(qr, { small: true });
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

    // --- 2. مدیریت تغییرات اعضای گروه ---
    sock.ev.on('group-participants.update', async (data) => {
        const { id: groupJid, participants, action } = data;

        // پاک کردن کش ادمین‌ها برای گروه مورد نظر
        if (groupAdmins[groupJid]) {
            delete groupAdmins[groupJid];
        }

        // ارسال پیام وقتی ربات ادمین می‌شود
        if (action === 'promote' && participants.includes(sock.user.id)) {
            await sock.sendMessage(groupJid, { text: BOT_INTRO });
            console.log(`Bot promoted in group. Sent intro message.`);
        }
    });

    // --- 3. مدیریت پیام‌ها (حذف لینک و اخراج) ---
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

            // حذف پیام
            await sock.sendMessage(remoteJid, { delete: msg.key });
            console.log(`🗑️ Deleted link from: ${senderJid.split('@')[0]}`);

            // شمارش و اخراج
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

startBot();