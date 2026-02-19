// The Mercury web-app server
const express = require("express");
const app = express();
const socket = require('socket.io');
const osc = require('node-osc');

let verbose = false;
if (process.argv.length > 2){
	if (process.argv[2] === '--log'){
		verbose = true;
	}
}

app.use(express.json());
app.use(express.static("public"));

const port = process.env.PORT || 8080;
const server = app.listen(port, () => {
	console.log(`Mercury Playground running`);
	console.log(`Use 'node server.js --log' to monitor incoming/outgoing osc-messages\n`);
	console.log(`Visit http://localhost:${port}\n`);
});

const io = socket(server);

app.get("/", (request, response) => {
	response.sendFile(__dirname + "/public/index.html");
});

app.post('/api/code', (req, res) => {
	const code = req.body.code;
	if (!code) {
		return res.status(400).json({ status: 'error', message: 'Missing "code" in request body' });
	}
	io.emit('osc', ['/mercury-code', code]);
	verboseLog('API /api/code:', code);
	res.json({ status: 'ok' });
});

app.post('/api/silence', (req, res) => {
	io.emit('osc', ['/mercury-code', 'silence']);
	verboseLog('API /api/silence');
	res.json({ status: 'ok' });
});

// --- Kokoro TTS endpoint ---
let kokoroTTS = null;
let kokoroLoading = null;
const ttsCache = new Map();
const TTS_CACHE_MAX = 200;

async function getKokoroTTS() {
	if (kokoroTTS) return kokoroTTS;
	if (kokoroLoading) return kokoroLoading;

	console.log('Loading Kokoro TTS model (this may take a moment on first use)...');
	kokoroLoading = (async () => {
		const { KokoroTTS } = require('kokoro-js');
		const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
			dtype: 'q8',
			device: 'cpu',
		});
		kokoroTTS = tts;
		kokoroLoading = null;
		console.log('Kokoro TTS model loaded successfully');
		return tts;
	})();

	return kokoroLoading;
}

function float32ToWav(float32, sampleRate) {
	const numSamples = float32.length;
	const buffer = Buffer.alloc(44 + numSamples * 2);

	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(36 + numSamples * 2, 4);
	buffer.write('WAVE', 8);
	buffer.write('fmt ', 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write('data', 36);
	buffer.writeUInt32LE(numSamples * 2, 40);

	for (let i = 0; i < numSamples; i++) {
		const s = Math.max(-1, Math.min(1, float32[i]));
		buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
	}

	return buffer;
}

app.post('/api/tts', async (req, res) => {
	try {
		const { text, voice, speed } = req.body;
		if (!text) {
			return res.status(400).json({ status: 'error', message: 'Missing "text" in request body' });
		}

		const voiceName = voice || 'af_heart';
		const spd = typeof speed === 'number' ? speed : 1;
		const cacheKey = `${text}|${voiceName}|${spd}`;

		if (ttsCache.has(cacheKey)) {
			res.set('Content-Type', 'audio/wav');
			return res.send(ttsCache.get(cacheKey));
		}

		const tts = await getKokoroTTS();
		const audio = await tts.generate(text, { voice: voiceName, speed: spd });

		const samples = audio.audio || audio.data;
		const sr = audio.sampling_rate || 24000;
		const wavBuffer = float32ToWav(samples, sr);

		if (ttsCache.size >= TTS_CACHE_MAX) {
			const firstKey = ttsCache.keys().next().value;
			ttsCache.delete(firstKey);
		}
		ttsCache.set(cacheKey, wavBuffer);

		verboseLog(`TTS rendered: "${text}" voice=${voiceName} speed=${spd}`);
		res.set('Content-Type', 'audio/wav');
		res.send(wavBuffer);
	} catch (err) {
		console.error('TTS error:', err);
		res.status(500).json({ status: 'error', message: err.message });
	}
});

app.get('/api/tts/voices', async (req, res) => {
	try {
		const tts = await getKokoroTTS();
		res.json(tts.voices);
	} catch (err) {
		res.status(500).json({ status: 'error', message: err.message });
	}
});

// OSC connection when running as localhost via npm start
const inPort = 4880;
const outPort = 2440;

io.sockets.on('connection', (socket) => {
	console.log('Connected', socket.id);
	socket.emit('connected', socket.id);

	const oscServer = new osc.Server(inPort, '127.0.0.1');
	oscServer.on('listening', () => {
		console.log(`Send messages to Mercury on port ${inPort}`);
	});
	oscServer.on('message', (msg) => {
		socket.emit('osc', msg);
		verboseLog('Send:', msg);
	});

	const oscClient = new osc.Client('127.0.0.1', outPort);
	console.log(`Receive messages from Mercury on port ${outPort}`);
	socket.on('message', (msg) => {
		oscClient.send(msg);
		verboseLog('Received:', msg);
	});

	socket.on('disconnect', () => {
		oscServer.close();
		console.log('Disconnected', socket.id);
	});
});

function verboseLog(...m){
	if (verbose){
		console.log(m);
	}
}