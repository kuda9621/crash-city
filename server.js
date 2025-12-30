const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const Filter = require('bad-words');
const filter = new Filter();

app.use(express.static('public'));

let players = {};
let bots = {};
let buildings = []; 
let buildingBBs = []; 
let highScores = []; 

const CELL_SIZE = 200; 
const MAP_SIZE = 2000;
let grid = {}; 

const MAX_BOTS = 50; 
const DELETE_DIST = 300; 
const DELETE_DIST_SQ = DELETE_DIST * DELETE_DIST; 

const adjectives = ["Angry", "Mad", "Crazy", "Wild", "Killer", "Dark", "Iron", "Brutal", "Fast", "Hyper"];
const nouns = ["Racer", "Truck", "Tank", "Beast", "Shark", "Bull", "Demon", "Hunter", "Viper", "Hammer"];

function generateBotName() {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 99);
    return `${adj}${noun}${num}`;
}

function generateMap() {
    const citySize = 25; 
    const unitSize = 40;
    buildings = [];
    buildingBBs = [];
    for(let x = -citySize; x <= citySize; x++) {
        for(let z = -citySize; z <= citySize; z++) {
            if(Math.abs(x) < 2 && Math.abs(z) < 2) continue; 
            if (x % 4 === 0 || z % 4 === 0) { if (Math.random() > 0.1) continue; }
            if (Math.random() < 0.3) continue; 
            
            const w = Math.random() * 20 + 10;
            const h = Math.random() * 60 + 20;
            const d = Math.random() * 20 + 10;
            
            const posX = x * unitSize + (Math.random() - 0.5) * 10;
            const posZ = z * unitSize + (Math.random() - 0.5) * 10;

            buildings.push({ x: posX, y: h/2, z: posZ, w: w, h: h, d: d });
            
            buildingBBs.push({ 
                minX: posX - w/2 - 2,
                maxX: posX + w/2 + 2, 
                minZ: posZ - d/2 - 2, 
                maxZ: posZ + d/2 + 2 
            });
        }
    }
}
generateMap();

function isPositionSafe(x, z) {
    for (let bb of buildingBBs) {
        if (x > bb.minX && x < bb.maxX && z > bb.minZ && z < bb.maxZ) return false; 
    }
    for (let pid in players) {
        const p = players[pid];
        if (!p.isDead) {
            const distSq = (p.x - x)**2 + (p.z - z)**2;
            if (distSq < 60) return false;
        }
    }
    for (let bid in bots) {
        const b = bots[bid];
        if (!b.isDead) {
            const distSq = (b.x - x)**2 + (b.z - z)**2;
            if (distSq < 60) return false;
        }
    }
    return true; 
}

function getSafeSpawnPosition() {
    for(let i=0; i<100; i++) { 
        const x = (Math.random() - 0.5) * 1800; 
        const z = (Math.random() - 0.5) * 1800;
        if(isPositionSafe(x, z)) return { x, z };
    }
    return { x: 0, z: 900 }; 
}

function createBot(id) {
    const cW = 4 + Math.random();
    const cH = 2 + Math.random();
    const cD = 9 + Math.random();
    const spawnPos = getSafeSpawnPosition();

    bots[id] = {
        id: id,
        name: generateBotName(),
        x: spawnPos.x, 
        z: spawnPos.z,
        rotation: Math.random() * Math.PI * 2,
        speed: 0,
        hp: 5,
        isDead: false,
        isBot: true, 
        color: '#ff3333', 
        carSpec: { type: 0, cW: cW, cH: cH, cD: cD, tW: cW*0.8, tH: 1.5, tD: cD*0.6 },
        changeDirTimer: 0,
        stunTimer: 0
    };
}

function updateRankings(name, survivalTimeMs) {
    highScores.push({ name: name, time: survivalTimeMs });
    highScores.sort((a, b) => b.time - a.time);
    if (highScores.length > 5) highScores = highScores.slice(0, 5);
    io.emit('updateRankings', highScores);
}

function handleDamage(playerId, sourceAngle) {
    const p = players[playerId];
    if (!p || p.isDead) return;

    const now = Date.now();
    if (now > p.invulnUntil) {
        p.hp -= 1;
        p.invulnUntil = now + 1000; 
        io.emit('updateHealth', { id: playerId, hp: p.hp });

        if (p.hp <= 0) {
            p.isDead = true;
            io.emit('playerDied', playerId);
            const survivalTime = now - p.startTime;
            updateRankings(p.name, survivalTime);
        } else {
            const pushAngle = sourceAngle !== undefined ? sourceAngle : p.rotation + Math.PI;
            io.to(playerId).emit('forcePush', { angle: pushAngle, force: 0.3 });
        }
    }
}

function getGridKey(x, z) {
    return `${Math.floor(x / CELL_SIZE)}_${Math.floor(z / CELL_SIZE)}`;
}

function addToGrid(entity) {
    const key = getGridKey(entity.x, entity.z);
    if (!grid[key]) grid[key] = [];
    grid[key].push(entity);
}

function getNearbyEntities(x, z) {
    let entities = [];
    const cellX = Math.floor(x / CELL_SIZE);
    const cellZ = Math.floor(z / CELL_SIZE);
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            const key = `${cellX + i}_${cellZ + j}`;
            if (grid[key]) entities = entities.concat(grid[key]);
        }
    }
    return entities;
}

function isColliding(x, z, excludeId) {
    for (let bb of buildingBBs) {
        if (x > bb.minX && x < bb.maxX && z > bb.minZ && z < bb.maxZ) {
            return { type: 'building' };
        }
    }
    const checkList = getNearbyEntities(x, z);
    for (let entity of checkList) {
        if (entity.id === excludeId || entity.isDead) continue;
        let dx = Math.abs(x - entity.x);
        let dz = Math.abs(z - entity.z);
        if (dx > 1000) dx = 2000 - dx;
        if (dz > 1000) dz = 2000 - dz;
        const sq = dx*dx + dz*dz;
        if (sq < 60) {
            return { type: 'entity', id: entity.id };
        }
    }
    return null;
}

io.on('connection', (socket) => {
    socket.emit('mapData', buildings);
    socket.emit('updateRankings', highScores); 

    socket.on('joinGame', (nickname) => {
        let cleanName = "Guest";
        try { cleanName = filter.clean(nickname); } catch (e) { cleanName = "User"; }
        const randomColor = '#' + Math.floor(Math.random()*16777215).toString(16);
        const cW = 3.5 + Math.random() * 2.0; 
        const cH = 1.5 + Math.random() * 1.5; 
        const cD = 8.0 + Math.random() * 4.0;
        const spawnPos = getSafeSpawnPosition();

        players[socket.id] = {
            id: socket.id,
            name: cleanName,
            x: spawnPos.x,
            z: spawnPos.z,
            rotation: 0,
            hp: 5,
            isDead: false,
            color: randomColor,
            carSpec: { type: 0, cW: cW, cH: cH, cD: cD, tW: cW * 0.8, tH: 1.5, tD: cD * 0.6 },
            startTime: Date.now(),
            invulnUntil: 0 
        };

        socket.emit('currentPlayers', { ...players, ...bots });
        socket.broadcast.emit('newPlayer', { id: socket.id, playerInfo: players[socket.id] });
    });

    socket.on('playerMovement', (movementData) => {
        if (players[socket.id] && !players[socket.id].isDead) {
            if (!isNaN(movementData.x) && !isNaN(movementData.z)) {
                players[socket.id].x = movementData.x;
                players[socket.id].z = movementData.z;
                players[socket.id].rotation = movementData.rotation;
                socket.broadcast.emit('playerMoved', { id: socket.id, playerInfo: players[socket.id] });
            }
        }
    });

    socket.on('playerHit', () => { handleDamage(socket.id); });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('removePlayer', socket.id);
    });
});

setInterval(() => {
    const playerIds = Object.keys(players);
    let botIds = Object.keys(bots);
    grid = {};
    playerIds.forEach(id => { if (!players[id].isDead) addToGrid(players[id]); });
    botIds.forEach(id => { if (!bots[id].isDead) addToGrid(bots[id]); });

    let activeBots = [];
    botIds.forEach(bid => {
        const bot = bots[bid];
        let minSq = 999999999;
        playerIds.forEach(pid => {
            const p = players[pid];
            if(!p.isDead) {
                let dx = Math.abs(p.x - bot.x);
                let dz = Math.abs(p.z - bot.z);
                if (dx > 1000) dx = 2000 - dx;
                if (dz > 1000) dz = 2000 - dz;
                const sq = dx*dx + dz*dz;
                if(sq < minSq) minSq = sq;
            }
        });
        if (playerIds.length > 0 && minSq > DELETE_DIST_SQ) {
            delete bots[bid];
            io.emit('removePlayer', bid);
        } else {
            activeBots.push(bid);
        }
    });
    botIds = activeBots; 

    let desiredCount = playerIds.length + 3;
    if (desiredCount > MAX_BOTS) desiredCount = MAX_BOTS;
    if (playerIds.length === 0) desiredCount = 0;

    if (botIds.length < desiredCount) {
        const newBotId = 'bot_' + Date.now() + Math.random();
        createBot(newBotId); 
        io.emit('newPlayer', { id: newBotId, playerInfo: bots[newBotId] });
        addToGrid(bots[newBotId]);
    } else if (botIds.length > desiredCount) { 
        const removeId = botIds[0];
        delete bots[removeId];
        io.emit('removePlayer', removeId);
    }

    Object.values(bots).forEach(bot => {
        if(bot.isDead) return;
        if (isNaN(bot.x) || isNaN(bot.z)) { bot.x = 0; bot.z = 0; }

        if (bot.stunTimer > 0) {
            bot.stunTimer--; 
            bot.speed = 0; 
            io.emit('playerMoved', { id: bot.id, playerInfo: bot });
            return; 
        }

        let closestSq = 999999999;
        let targetPlayer = null;
        const nearbyEntities = getNearbyEntities(bot.x, bot.z);

        nearbyEntities.forEach(entity => {
            if (players[entity.id] && !entity.isDead) { 
                let dx = Math.abs(entity.x - bot.x);
                let dz = Math.abs(entity.z - bot.z);
                if (dx > 1000) dx = 2000 - dx;
                if (dz > 1000) dz = 2000 - dz;
                const sq = dx*dx + dz*dz;
                if(sq < closestSq) { closestSq = sq; targetPlayer = entity; }
            }
        });

        if (targetPlayer && closestSq < 62500) { 
             const angleToPlayer = Math.atan2(targetPlayer.x - bot.x, targetPlayer.z - bot.z);
             let diff = angleToPlayer - bot.rotation;
             while (diff > Math.PI) diff -= Math.PI * 2;
             while (diff < -Math.PI) diff += Math.PI * 2;
             bot.rotation += diff * 0.3; 
             bot.speed = 1.6; 
        } else {
            bot.speed = 0.6; 
            bot.changeDirTimer--;
            if (bot.changeDirTimer <= 0) {
                bot.rotation += (Math.random() - 0.5); 
                bot.changeDirTimer = 50 + Math.random() * 50;
            }
        }

        const nextX = bot.x + Math.sin(bot.rotation) * bot.speed;
        const nextZ = bot.z + Math.cos(bot.rotation) * bot.speed;

        const colX = isColliding(nextX, bot.z, bot.id);
        const colZ = isColliding(bot.x, nextZ, bot.id);

        let moved = false;
        let hitTarget = null; // 충돌 대상 저장

        if (!colX) { bot.x = nextX; moved = true; } 
        else { 
            // 움직이지 못했더라도(moved=false), 누구랑 부딪혔는지 기록
            if (colX.type === 'entity') hitTarget = colX;
            if (colX.type === 'entity' && players[colX.id]) handleDamage(colX.id, bot.rotation);
        }

        if (!colZ) { bot.z = nextZ; moved = true; } 
        else { 
            if (colZ.type === 'entity') hitTarget = colZ;
            if (colZ.type === 'entity' && players[colZ.id]) handleDamage(colZ.id, bot.rotation);
        }

        if (bot.x > 1000) bot.x = -1000;
        else if (bot.x < -1000) bot.x = 1000;
        if (bot.z > 1000) bot.z = -1000;
        else if (bot.z < -1000) bot.z = 1000;

        // [핵심 수정] 움직였더라도(moved=true), 유저랑 부딪혔다면(hitTarget) 강제 스턴
        if (!moved || (hitTarget && players[hitTarget.id])) {
            bot.speed = 0; 
            bot.stunTimer = 60; // 2초 스턴

            if (hitTarget && players[hitTarget.id]) {
                const p = players[hitTarget.id];
                const angle = Math.atan2(bot.x - p.x, bot.z - p.z); 
                bot.x += Math.sin(angle) * 30; // 강력 튕김
                bot.z += Math.cos(angle) * 30;
            } else {
                bot.x -= Math.sin(bot.rotation) * 20; 
                bot.z -= Math.cos(bot.rotation) * 20;
            }
        }

        io.emit('playerMoved', { id: bot.id, playerInfo: bot });
    });
}, 1000 / 30); 

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});