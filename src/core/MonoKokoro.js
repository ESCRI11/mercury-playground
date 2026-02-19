const Tone = require('tone');
const Util = require('./Util.js');
const Instrument = require('./Instrument.js');

const KOKORO_VOICES = [
	'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore',
	'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
	'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
	'am_michael', 'am_onyx', 'am_puck', 'am_santa',
	'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
	'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

let _browserTTS = null;
let _browserLoading = null;

class MonoKokoro extends Instrument {
	constructor(engine, t, canvas, line){
		super(engine, canvas, line);

		// Bypass the default 6ms ADSR envelope so kokoro speech plays
		// through naturally. Users can still add env() explicitly.
		this._att = null;

		this._voice = 'af_heart';
		this._textSeq = ['hello'];
		this._bufferCache = {};
		this._speed = [ 1 ];
		this._renderSpeed = 1;
		this._rendering = {};

		this.sample;
		this.createSource();

		console.log('=> MonoKokoro()', this);
	}

	createSource(){
		this.sample = new Tone.Player().connect(this.channelStrip());
		this.sample.autostart = false;
		this.source = this.sample;
	}

	event(c, time){
		// Force the parent's envelope logic to take the "no envelope" path,
		// which sets adsr.gain = 1.0. Speech needs full duration playback.
		let savedAtt = this._att;
		this._att = null;
		super.event(c, time);
		this._att = savedAtt;
	}

	sourceEvent(c, e, time){
		let text = Util.getParam(this._textSeq, c);
		if (typeof text !== 'string') text = String(text);

		let key = this._cacheKey(text);
		let buf = this._bufferCache[key];
		if (!buf) return;

		if (this.sample.buffer){
			this.sample.buffer.dispose();
		}
		this.sample.buffer = buf;

		let s = Util.getParam(this._speed, c);
		this.sample.playbackRate = Math.max(Math.abs(s), 0.0001);

		if (this.sample.loaded){
			this.sample.start(time);
		}
	}

	_cacheKey(text){
		return text + '|' + this._voice + '|' + this._renderSpeed;
	}

	async _renderBuffer(text){
		let key = this._cacheKey(text);
		if (this._bufferCache[key]) return this._bufferCache[key];
		if (this._rendering[key]) return this._rendering[key];

		this._rendering[key] = (async () => {
			let buf = null;
			try {
				buf = await this._renderViaServer(text);
			} catch (err) {
				console.warn('Kokoro server TTS failed, trying browser fallback:', err.message);
				try {
					buf = await this._renderViaBrowser(text);
				} catch (err2) {
					console.warn('Kokoro browser TTS also failed:', err2.message);
				}
			}
			delete this._rendering[key];
			if (buf) this._bufferCache[key] = buf;
			return buf;
		})();

		return this._rendering[key];
	}

	async _renderViaServer(text){
		let resp = await fetch('/api/tts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				text: text.replace(/_/g, ' '),
				voice: this._voice,
				speed: this._renderSpeed,
			}),
		});

		if (!resp.ok){
			throw new Error(`Server returned ${resp.status}`);
		}

		let arrayBuf = await resp.arrayBuffer();
		return this._parseWavToBuffer(arrayBuf);
	}

	async _renderViaBrowser(text){
		let tts = await this._getBrowserTTS();
		let audio = await tts.generate(text.replace(/_/g, ' '), {
			voice: this._voice,
			speed: this._renderSpeed,
		});

		let samples = audio.audio || audio.data;
		let sr = audio.sampling_rate || 24000;
		let audioBuf = Tone.context.createBuffer(1, samples.length, sr);
		audioBuf.getChannelData(0).set(samples);
		return new Tone.ToneAudioBuffer(audioBuf);
	}

	async _getBrowserTTS(){
		if (_browserTTS) return _browserTTS;
		if (_browserLoading) return _browserLoading;

		log('Loading Kokoro TTS in browser (first time may take a moment)...');
		_browserLoading = (async () => {
			let mod = await import('/lib/kokoro.web.js');
			let tts = await mod.KokoroTTS.from_pretrained(
				'onnx-community/Kokoro-82M-v1.0-ONNX',
				{ dtype: 'q8', device: 'wasm' }
			);
			_browserTTS = tts;
			_browserLoading = null;
			log('Kokoro TTS browser model loaded');
			return tts;
		})();

		return _browserLoading;
	}

	_parseWavToBuffer(wavArrayBuffer){
		let view = new DataView(wavArrayBuffer);
		let numChannels = view.getUint16(22, true);
		let sampleRate = view.getUint32(24, true);
		let bitsPerSample = view.getUint16(34, true);

		let dataOffset = 44;
		let dataSize = wavArrayBuffer.byteLength - dataOffset;
		let bytesPerSample = bitsPerSample / 8;
		let numSamples = Math.floor(dataSize / bytesPerSample);

		if (numSamples <= 0) return null;

		let float32 = new Float32Array(numSamples);

		if (bitsPerSample === 16) {
			for (let i = 0; i < numSamples; i++){
				float32[i] = view.getInt16(dataOffset + i * 2, true) / 32768.0;
			}
		} else if (bitsPerSample === 8) {
			let bytes = new Uint8Array(wavArrayBuffer, dataOffset);
			for (let i = 0; i < numSamples; i++){
				float32[i] = (bytes[i] - 128) / 128.0;
			}
		} else {
			console.warn('Kokoro: unsupported bits per sample:', bitsPerSample);
			return null;
		}

		let audioBuf = Tone.context.createBuffer(numChannels, numSamples, sampleRate);
		audioBuf.getChannelData(0).set(float32);
		return new Tone.ToneAudioBuffer(audioBuf);
	}

	prerender(){
		let unique = [...new Set(this._textSeq.map(String))];
		unique.forEach(text => {
			this._renderBuffer(text).then(buf => {
				if (buf) {
					console.log(`Kokoro pre-rendered: "${text}"`);
				}
			});
		});
	}

	say(...words){
		let flat = [];
		words.forEach(w => {
			if (Array.isArray(w)){
				flat = flat.concat(w);
			} else {
				flat.push(String(w));
			}
		});
		if (flat.length > 0) this._textSeq = flat;
	}

	voice(v){
		let name = String(v).toLowerCase();
		if (KOKORO_VOICES.indexOf(name) < 0){
			log(`Kokoro voice '${v}' not available. Available: ${KOKORO_VOICES.join(', ')}`);
			return;
		}
		if (name !== this._voice){
			this._voice = name;
			this._bufferCache = {};
		}
	}

	speed(s){
		this._speed = Util.toArray(s);
	}

	renderSpeed(s){
		let v = Number(s);
		if (v > 0){
			this._renderSpeed = v;
			this._bufferCache = {};
		}
	}

	delete(){
		super.delete();
		this._bufferCache = {};
		this._rendering = {};
		console.log('=> disposed MonoKokoro()');
	}
}

MonoKokoro.VOICES = KOKORO_VOICES;
module.exports = MonoKokoro;
