const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeInMemoryStore,
    jidDecode
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const db = require('./database');
const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

let masterSock = null;
let masterIsInitializing = false;
let masterQr = null;
const targetGroupIds = new Map(); // hotelId -> groupId
const reverseGroupMap = new Map(); // groupId -> hotelId
let discordClient;

const HOTEL_CHANNELS = {
    'BW_SF': '1482525707870408878',  // Springfield
    'BW_TO': '1482553974635888670',  // Thousands Oaks
    'ECL_GF': '1482554071008280709'  // Grand Folks
};

const HOTEL_INVITES = {
    'BW_SF': 'J5ZYINxLucuBMQu7vJetum',
    'BW_TO': 'DD5oF7KeSJS61gNjRqAkLA',
    'ECL_GF': 'D6ogScrxZmq3H2U5zFZrcC'   // Fixed: Grand Folks
};

const MGMT_PORTAL_CHANNEL_ID = '1482525707870408878';
const DEV_LOG_CHANNEL_ID = '1482390354547314688';

// Initialize the Single Master WhatsApp session
async function initWhatsApp(client_discord) {
    if (masterSock) {
        console.log(`[WHATSAPP] Master session already exists.`);
        return;
    }
    if (masterIsInitializing) {
        console.log(`[WHATSAPP] Master session is already initializing...`);
        return;
    }
    
    masterIsInitializing = true;
    try {
        discordClient = client_discord;

    console.log(`[WHATSAPP] Initializing Single Master Baileys engine...`);

    // Load ALL group mappings from DB
    for (const hotelId of Object.keys(HOTEL_CHANNELS)) {
        const configKey = `whatsapp_group_id_${hotelId}`;
        const row = db.prepare("SELECT value FROM config WHERE key = ?").get(configKey);
        if (row && row.value) {
            targetGroupIds.set(hotelId, row.value);
            reverseGroupMap.set(row.value, hotelId);
            console.log(`[WHATSAPP] Mapping loaded [${hotelId}] -> ${row.value}`);
        }
    }

    const sessionPath = `auth_info_baileys_master`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            // printQRInTerminal: true, // DEPRECATED - removed
            logger: pino({ level: 'silent' }), 
            browser: [`Aavgo Master Bridge`, "Chrome", "1.0.0"]
        });

    masterSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            masterQr = qr;
            notifyDiscordAuthNeeded(qr);
            
            // Manual Terminal QR Output (Replacement for deprecated printQRInTerminal)
            QRCode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
                if (!err) {
                    console.log("\n[WHATSAPP] SCAN THIS QR CODE FOR MASTER BRIDGE:\n");
                    console.log(url);
                }
            });
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[WHATSAPP] Master connection closed. Reason: ${statusCode}. Reconnecting:`, shouldReconnect);
            
            masterSock = null;
            masterIsInitializing = false;
            
            if (shouldReconnect) {
                // Reconnect with a slight delay to avoid tight loops
                setTimeout(() => initWhatsApp(discordClient), 5000);
            } else if (statusCode === DisconnectReason.loggedOut) {
                console.warn("[WHATSAPP] Fatal disconnect (Logged Out). Purging session...");
                removeWhatsApp(); // Auto-purge old session to allow fresh QR
            }
        } else if (connection === 'open') {
            console.log(`[WHATSAPP] Master connection opened successfully!`);
            masterQr = null;
            masterIsInitializing = false;
            
            // Re-sync all group links
            for (const [hotelId, inviteCode] of Object.entries(HOTEL_INVITES)) {
                let currentTarget = targetGroupIds.get(hotelId);
                
                // If not linked, try to resolve JID
                if (!currentTarget && inviteCode) {
                    console.log(`[WHATSAPP] Resolving JID for [${hotelId}]: ${inviteCode}...`);
                    try {
                        const info = await sock.groupGetInviteInfo(inviteCode);
                        const groupJid = decodeJid(info.id);
                        targetGroupIds.set(hotelId, groupJid);
                        reverseGroupMap.set(groupJid, hotelId);
                        db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(`whatsapp_group_id_${hotelId}`, groupJid);
                        console.log(`[WHATSAPP] Successfully linked [${hotelId}] -> ${groupJid}`);
                        currentTarget = groupJid;
                        
                        // Also try to join just in case
                        await sock.groupAcceptInvite(inviteCode).catch(() => {});
                    } catch (err) {
                        console.error(`[WHATSAPP] JID resolution failed for [${hotelId}]:`, err.message);
                    }
                }
                
                if (currentTarget) {
                    console.log(`[WHATSAPP] Status: [${hotelId}] is LINKED to ${currentTarget}`);
                }
            }

            notifyDiscordReady();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            if (msg.key.fromMe) continue;
            
            const from = decodeJid(msg.key.remoteJid);
            const content = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message;
            if (!content) continue;

            const body = content.conversation || 
                         content.extendedTextMessage?.text || 
                         content.imageMessage?.caption ||
                         content.videoMessage?.caption ||
                         (content.imageMessage ? '[Image]' : '') ||
                         (content.videoMessage ? '[Video]' : '') ||
                         (content.documentMessage ? '[Document]' : '');

            if (!body) continue;

            // Multiplexing: Check which hotel group this belongs to
            const hotelId = reverseGroupMap.get(from);
            if (hotelId) {
                console.log(`[BRIDGE] WA [${hotelId}] -> Discord: ${body}`);
                bridgeToDiscord(msg, body, hotelId);
            }
        }
    });
    } catch (err) {
        console.error(`[WHATSAPP] Master initialization failed:`, err);
        masterIsInitializing = false;
        masterSock = null;
    }
}

function decodeJid(jid) {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
        const decode = jidDecode(jid) || {};
        return decode.user && decode.server && decode.user + '@' + decode.server || jid;
    }
    return jid;
}

async function bridgeToDiscord(msg, body, hotelId) {
    if (!discordClient) return;
    try {
        const channelId = HOTEL_CHANNELS[hotelId] || MGMT_PORTAL_CHANNEL_ID;
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) return;

        const senderJid = decodeJid(msg.key.participant || msg.key.remoteJid);
        const contactName = msg.pushName || senderJid.split('@')[0];

        const embed = new EmbedBuilder()
            .setAuthor({ name: `WhatsApp (${hotelId}): ${contactName}` })
            .setDescription(body)
            .setColor(0x25D366)
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error(`[WHATSAPP] [${hotelId}] Bridge failure:`, err);
    }
}

async function sendToWhatsApp(content, hotelId) {
    if (!masterSock) {
        console.warn(`[WHATSAPP] Master socket not ready.`);
        return false;
    }
    
    const targetGroupId = targetGroupIds.get(hotelId);
    if (!targetGroupId) {
        console.warn(`[WHATSAPP] No group linked for hotel: ${hotelId}`);
        return false;
    }

    try {
        await masterSock.sendMessage(targetGroupId, { text: content });
        return true;
    } catch (err) {
        console.error(`[WHATSAPP] [${hotelId}] Send failure:`, err);
        return false;
    }
}

async function joinGroupByInvite(inviteLink, hotelId) {
    if (!masterSock) return { success: false, message: 'Master Bridge not ready.' };
    try {
        const inviteCode = inviteLink.split('chat.whatsapp.com/')[1];
        if (!inviteCode) return { success: false, message: 'Invalid invite link format.' };
        
        const response = await masterSock.groupAcceptInvite(inviteCode);
        const groupJid = decodeJid(response);
        
        if (hotelId && hotelId !== 'DEFAULT') {
            targetGroupIds.set(hotelId, groupJid);
            reverseGroupMap.set(groupJid, hotelId);
            db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(`whatsapp_group_id_${hotelId}`, groupJid);
        }
        
        return { success: true, message: `Joined group! ID: ${groupJid}` };
    } catch (err) {
        console.error(`[WHATSAPP] Join failed:`, err);
        return { success: false, message: `Join failed: ${err.message}` };
    }
}

function getStatus(hotelId) {
    if (!masterSock) return { connected: false, message: 'Master Service not started.' };
    
    const targetGroupId = targetGroupIds.get(hotelId);
    if (targetGroupId) {
        return { connected: true, message: `[${hotelId}] Online and Linked: ${targetGroupId}` };
    }
    return { connected: true, message: `[${hotelId}] Online but no group linked for this hotel.` };
}

function getQr() {
    return masterQr;
}

async function restartWhatsApp(client_discord) {
    if (masterSock) {
        console.log(`[WHATSAPP] Restarting MASTER session...`);
        await masterSock.logout().catch(() => {});
        masterSock = null;
        masterIsInitializing = false;
    }
    return initWhatsApp(client_discord);
}

async function removeWhatsApp() {
    console.log(`[WHATSAPP] PURGING MASTER session data...`);
    
    if (masterSock) {
        await masterSock.logout().catch(() => {});
        masterSock = null;
    }
    
    masterIsInitializing = false;
    masterQr = null;
    
    // session folder: auth_info_baileys_master
    const sessionPath = `auth_info_baileys_master`;
    if (fs.existsSync(sessionPath)) {
        try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[WHATSAPP] Deleted session folder: ${sessionPath}`);
        } catch (err) {
            console.error(`[WHATSAPP] Failed to delete session folder:`, err.message);
        }
    }
    
    return { success: true, message: `Successfully removed Master WhatsApp bridge and purged state.` };
}

async function notifyDiscordAuthNeeded(qrString) {
    if (!discordClient) {
        console.error("[WHATSAPP] Cannot notify Discord: discordClient is null");
        return;
    }
    try {
        console.log("[WHATSAPP] Fetching Dev Log Channel:", DEV_LOG_CHANNEL_ID);
        const channel = await discordClient.channels.fetch(DEV_LOG_CHANNEL_ID);
        if (channel) {
            console.log("[WHATSAPP] Sending QR code to Discord...");
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrString)}`;
            
            const embed = new EmbedBuilder()
                .setTitle(`🟡 WhatsApp MASTER Auth Needed`)
                .setDescription(`Scan this QR code with your WhatsApp app.\n\n**Note**: This 1 account will handle ALL hotels automatically.`)
                .setImage(qrImageUrl)
                .setColor(0xFEE75C);

            await channel.send({ embeds: [embed] });
            console.log("[WHATSAPP] QR code sent successfully.");
        } else {
            console.error("[WHATSAPP] Dev Log Channel not found!");
        }
    } catch (e) {
        console.error("[WHATSAPP] Failed to notify Discord of QR:", e.message);
    }
}

async function notifyDiscordReady() {
    if (!discordClient) return;
    try {
        const channel = await discordClient.channels.fetch(DEV_LOG_CHANNEL_ID);
        if (channel) {
            await channel.send(`🟢 **WhatsApp Master Bridge is Online and Multiplexing.**`);
        }
    } catch (e) {}
}

function getAllStatuses() {
    const statuses = {};
    const isOnline = masterSock && !masterIsInitializing;
    
    for (const hotelId of Object.keys(HOTEL_CHANNELS)) {
        if (isOnline) {
            const linked = targetGroupIds.get(hotelId);
            statuses[hotelId] = linked ? 'online' : 'connecting';
        } else {
            statuses[hotelId] = 'offline';
        }
    }
    return statuses;
}

module.exports = {
    initWhatsApp,
    sendToWhatsApp,
    getStatus,
    getQr,
    joinGroupByInvite,
    restartWhatsApp,
    removeWhatsApp,
    getAllStatuses
};
