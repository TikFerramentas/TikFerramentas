// =====================================================
// TikFerramentas - Servidor Local
// Roda no PC do streamer durante a live
// =====================================================

const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const { Server } = require('socket.io');
const express = require('express');
const http = require('http');
const path = require('path');

const PORT = 3000;

const app = express();
const server = http.createServer(app);

// Permite conexão do site (GitHub Pages ou local)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve a pasta "public" se quiser rodar o site local também
app.use(express.static(path.join(__dirname, 'public')));

// Rota de status (pra checar se servidor tá rodando)
app.get('/status', (req, res) => {
    res.json({ ok: true, version: '1.0.0' });
});

// =====================================================
// ESTADO DA SESSÃO
// =====================================================
let tikConnection = null;
let sessionData = {
    isLive: false,
    username: null,
    roomId: null,
    gifts: [],          // histórico de presentes
    topDonors: {},      // { username: totalCoins }
    totalGifts: 0,
    totalCoins: 0,
    likeCount: 0,
    viewerCount: 0,
    lastFollower: null,
    chatMessages: [],   // últimas 50 mensagens
};

function resetSession() {
    sessionData = {
        isLive: false,
        username: sessionData.username,
        roomId: null,
        gifts: [],
        topDonors: {},
        totalGifts: 0,
        totalCoins: 0,
        likeCount: 0,
        viewerCount: 0,
        lastFollower: null,
        chatMessages: [],
    };
}

// =====================================================
// SOCKET.IO — comunicação com o site
// =====================================================
io.on('connection', (socket) => {
    console.log(`[+] Site conectado (socket: ${socket.id})`);

    // Manda estado atual pra quem acabou de conectar
    socket.emit('session', sessionData);

    // ---- CONECTAR NA LIVE ----
    socket.on('start', async (username) => {
        if (!username) return socket.emit('error', 'Username vazio');

        // Desconecta sessão anterior se houver
        if (tikConnection) {
            try { tikConnection.disconnect(); } catch(e) {}
        }

        resetSession();
        sessionData.username = username;

        console.log(`[→] Tentando conectar em @${username}...`);
        io.emit('status', { connecting: true, username });

        tikConnection = new TikTokLiveConnection(username);

        try {
            const state = await tikConnection.connect();
            sessionData.isLive = true;
            sessionData.roomId = state.roomId;

            console.log(`[✓] Conectado! RoomId: ${state.roomId}`);
            io.emit('status', { live: true, username, roomId: state.roomId });

        } catch (err) {
            console.log(`[✗] Falhou: ${err.message}`);
            sessionData.isLive = false;

            if (err.message.includes('offline') || err.message.includes('not live')) {
                io.emit('status', { live: false, username, reason: 'offline' });
            } else {
                io.emit('status', { live: false, username, reason: err.message });
            }
            return;
        }

        // ---- EVENTOS DA LIVE ----

        // 🎁 PRESENTE
        tikConnection.on(WebcastEvent.GIFT, (data) => {
            const gift = {
                user: data.user.uniqueId,
                giftName: data.giftName || data.gift?.name || 'Presente',
                giftId: data.giftId,
                coins: data.diamondCount || 0,
                repeat: data.repeatCount || 1,
                emoji: '🎁',
                time: new Date().toLocaleTimeString('pt-BR'),
            };

            const totalCoins = gift.coins * gift.repeat;
            sessionData.totalGifts += gift.repeat;
            sessionData.totalCoins += totalCoins;
            sessionData.topDonors[gift.user] = (sessionData.topDonors[gift.user] || 0) + totalCoins;
            sessionData.gifts.unshift(gift);
            if (sessionData.gifts.length > 100) sessionData.gifts.pop();

            console.log(`[🎁] @${gift.user} enviou ${gift.giftName} x${gift.repeat}`);
            io.emit('gift', { ...gift, totalCoins });
            io.emit('stats', {
                totalGifts: sessionData.totalGifts,
                totalCoins: sessionData.totalCoins,
                topDonors: getTopDonors(),
            });
        });

        // 💬 CHAT
        tikConnection.on(WebcastEvent.CHAT, (data) => {
            const msg = {
                user: data.user.uniqueId,
                comment: data.comment,
                time: new Date().toLocaleTimeString('pt-BR'),
            };
            sessionData.chatMessages.unshift(msg);
            if (sessionData.chatMessages.length > 50) sessionData.chatMessages.pop();

            io.emit('chat', msg);
        });

        // ❤️ LIKE
        tikConnection.on(WebcastEvent.LIKE, (data) => {
            sessionData.likeCount = data.totalLikeCount || sessionData.likeCount;
            io.emit('like', { count: sessionData.likeCount });
        });

        // 👤 SEGUIDOR
        tikConnection.on(WebcastEvent.FOLLOW, (data) => {
            sessionData.lastFollower = data.user.uniqueId;
            console.log(`[👤] Novo seguidor: @${data.user.uniqueId}`);
            io.emit('follow', { user: data.user.uniqueId });
        });

        // 👁️ VIEWERS
        tikConnection.on(WebcastEvent.ROOM_USER, (data) => {
            sessionData.viewerCount = data.viewerCount || sessionData.viewerCount;
            io.emit('viewers', { count: sessionData.viewerCount });
        });

        // 🔌 DESCONECTADO
        tikConnection.on('disconnected', () => {
            console.log('[✗] Desconectado da live');
            sessionData.isLive = false;
            io.emit('status', { live: false, username, reason: 'ended' });
        });
    });

    // ---- DESCONECTAR ----
    socket.on('stop', () => {
        if (tikConnection) {
            tikConnection.disconnect();
            tikConnection = null;
        }
        resetSession();
        io.emit('status', { live: false });
        console.log('[-] Live desconectada pelo usuário');
    });

    // ---- PEDIR ESTADO ATUAL ----
    socket.on('get_session', () => {
        socket.emit('session', {
            ...sessionData,
            topDonors: getTopDonors(),
        });
    });

    socket.on('disconnect', () => {
        console.log(`[-] Site desconectado (socket: ${socket.id})`);
    });
});

// =====================================================
// HELPERS
// =====================================================
function getTopDonors(limit = 10) {
    return Object.entries(sessionData.topDonors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([user, coins], i) => ({ position: i + 1, user, coins }));
}

// =====================================================
// INICIA O SERVIDOR
// =====================================================
server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║   TikFerramentas - Servidor Ativo    ║');
    console.log(`║   http://localhost:${PORT}              ║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('');
    console.log('Aguardando conexão do site...');
    console.log('Não feche essa janela durante a live!');
    console.log('');
});