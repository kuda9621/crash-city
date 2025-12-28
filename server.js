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

// [최적화] Grid 시스템 설정
const CELL_SIZE = 200; 
let grid = {}; 

// [설정] 봇 절대 상한선
const MAX_BOTS = 50; 
const DELETE_DIST = 300; // 거리가 300 넘으면 삭제 (화면 밖으로 나가면 리스폰 유도)
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
            if(Math.abs(x) < 3 && Math.abs(z) < 3) continue; 
            if (x % 4 === 0 || z % 4 === 0) { if (Math.random() > 0.1) continue; }
            if (Math.random() < 0.3) continue;
            
            const w = Math.random() * 20 + 10;
            const h = Math.random() * 60 + 20;
            const d = Math.random() * 20 + 10;
            
            const posX = x * unitSize + (Math.random() - 0.5) * 10;
            const posZ = z * unitSize + (Math.random() - 0.5) * 10;

            buildings.push({ x: posX, y: h/2, z: posZ, w: w, h: h, d: d });
            
            buildingBBs.push({ 
                minX: posX - w/2 + 0.5,
                maxX: posX + w/2 - 0.5, 
                minZ: posZ - d/2 + 0.5, 
                maxZ: posZ + d/2 - 0.5 
            });
        }
    }
}
generateMap();

function createBot(id, spawnX, spawnZ) {
    const cW = 4 + Math.random();
    const cH = 2 + Math.random();
    const cD = 9 + Math.random();
    const x = spawnX !== undefined ? spawnX : (Math.random() - 0.5) * 200;
    const z = spawnZ !== undefined ? spawnZ : (Math.random() - 0.5) * 200;

    bots[id] = {
        id: id,
        name: generateBotName(),
        x: x, z: z,
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
            io.to(playerId).emit('forcePush', { angle: pushAngle, force: 2.0 });
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
            if (grid[key]) {
                entities = entities.concat(grid[key]);
            }
        }
    }
    return entities;
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

        players[socket.id] = {
            id: socket.id,
            name: cleanName,
            x: (Math.random() - 0.5) * 100,
            z: (Math.random() - 0.5) * 100,
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
            players[socket.id].x = movementData.x;
            players[socket.id].z = movementData.z;
            players[socket.id].rotation = movementData.rotation;
            socket.broadcast.emit('playerMoved', { id: socket.id, playerInfo: players[socket.id] });
        }
    });

    socket.on('playerHit', () => {
        handleDamage(socket.id); 
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('removePlayer', socket.id);
    });
});

setInterval(() => {
    const playerIds = Object.keys(players);
    let botIds = Object.keys(bots);
    
    // 1. 그리드 업데이트
    grid = {};
    playerIds.forEach(id => { if (!players[id].isDead) addToGrid(players[id]); });
    botIds.forEach(id => { if (!bots[id].isDead) addToGrid(bots[id]); });

    // [복구됨] 2. 멀리 간 봇 삭제 (재활용을 위해 필수)
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

        // 유저가 있는데 거리가 너무 멀면 삭제
        if (playerIds.length > 0 && minSq > DELETE_DIST_SQ) {
            delete bots[bid];
            io.emit('removePlayer', bid);
        } else {
            activeBots.push(bid);
        }
    });
    botIds = activeBots; // 삭제 후 남은 봇 목록 갱신

    // 3. 봇 수량 조절 및 스폰
    let desiredCount = playerIds.length + 3;
    if (desiredCount > MAX_BOTS) desiredCount = MAX_BOTS;
    if (playerIds.length === 0) desiredCount = 0;

    if (botIds.length < desiredCount) {
        const newBotId = 'bot_' + Date.now() + Math.random();
        let spawnX = 0, spawnZ = 0;
        if (playerIds.length > 0) {
            const targetP = players[playerIds[Math.floor(Math.random() * playerIds.length)]];
            const randomAngle = Math.random() * Math.PI * 2; 
            const spawnDist = 80 + Math.random() * 40; 
            spawnX = targetP.x + Math.sin(randomAngle) * spawnDist;
            spawnZ = targetP.z + Math.cos(randomAngle) * spawnDist;
        }
        createBot(newBotId, spawnX, spawnZ);
        io.emit('newPlayer', { id: newBotId, playerInfo: bots[newBotId] });
        addToGrid(bots[newBotId]);
    } else if (botIds.length > desiredCount) { 
        const removeId = botIds[0];
        delete bots[removeId];
        io.emit('removePlayer', removeId);
    }

    // 4. AI 로직
    Object.values(bots).forEach(bot => {
        if(bot.isDead) return;

        if (bot.stunTimer > 0) {
            bot.stunTimer--; 
            bot.speed *= 0.8; // 스턴 시 속도 감속 강화
        } else {
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
                 bot.speed = 1.7; 
            } else {
                bot.speed = 0.5; 
                bot.changeDirTimer--;
                if (bot.changeDirTimer <= 0) {
                    bot.rotation += (Math.random() - 0.5); 
                    bot.changeDirTimer = 50 + Math.random() * 50;
                }
            }
        }

        const nextX = bot.x + Math.sin(bot.rotation) * bot.speed;
        const nextZ = bot.z + Math.cos(bot.rotation) * bot.speed;

        let crashed = false;
        let hitUser = false;
        let hitEntityId = null;

        // 건물 충돌 체크
        for(let bb of buildingBBs) {
            if (nextX > bb.minX - 1 && nextX < bb.maxX + 1 && nextZ > bb.minZ - 1 && nextZ < bb.maxZ + 1) {
                crashed = true; break;
            }
        }

        if (!crashed) {
            const checkList = getNearbyEntities(nextX, nextZ); 
            for (let entity of checkList) {
                if (entity.id === bot.id || entity.isDead) continue;
                let dx = Math.abs(nextX - entity.x);
                let dz = Math.abs(nextZ - entity.z);
                if (dx > 1000) dx = 2000 - dx;
                if (dz > 1000) dz = 2000 - dz;
                const sq = dx*dx + dz*dz;
                
                // [수정 완료] 히트박스 거리 25 적용
                if (sq < 25) { 
                    crashed = true;
                    if (players[entity.id]) { hitUser = true; hitEntityId = entity.id; }
                    break;
                }
            }
        }

        if (crashed) {
            // [수정 완료] 건물에 박으면 멍때리는 문제 해결
            bot.speed = -1.5; // 강력한 후진
            bot.stunTimer = 30; // 잠시 방향 전환 시간 벌기
            bot.rotation += Math.PI + (Math.random() - 0.5); // 뒤로 돌면서 살짝 비틀기 (탈출 확률 증가)
            
            // 위치 강제 보정 (벽에서 튕겨 나오게)
            bot.x -= Math.sin(bot.rotation) * 5;
            bot.z -= Math.cos(bot.rotation) * 5;

            if (hitUser) {
                handleDamage(hitEntityId, bot.rotation);
            }
        } else {
            bot.x = nextX;
            bot.z = nextZ;
            if (bot.x > 1000) bot.x = -1000;
            else if (bot.x < -1000) bot.x = 1000;
            if (bot.z > 1000) bot.z = -1000;
            else if (bot.z < -1000) bot.z = 1000;
        }

        io.emit('playerMoved', { id: bot.id, playerInfo: bot });
    });
}, 1000 / 30); 

http.listen(process.env.PORT || 3000, () => {
    console.log('Server is running');
});