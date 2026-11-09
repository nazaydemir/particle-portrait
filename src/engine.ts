// draws the image as a swarm of characters with WebGL2.
// the movement is calculated in the vertex shader, so the cpu does no per-particle work.
import { DEFAULTS, type EngineOptions } from "./config";
import { VERTEX_SHADER, FRAGMENT_SHADER } from "./shaders";

// floats per particle: start(2) grid(2) delay(1) brightness(1) seed(1) rgb(3)
const FLOATS = 10;
const STRIDE = FLOATS * 4;
const SETTLED_TIME = 1e4; // a time so far ahead that every particle has landed
const MAX_CHARS = 100;

const UNIFORM_NAMES = [
    "uRes", "uOff", "uCell", "uTime", "uSize", "uChars",
    "uGain", "uDecay", "uOsc", "uAtlas", "uColorMode",
] as const;
type UniformName = (typeof UNIFORM_NAMES)[number];

// array.from so emoji and block characters count as one character
export function normalizeCharacters(raw: string): string[] {
    return Array.from(raw.replace(/[\r\n\t]/g, "")).slice(0, MAX_CHARS);
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Could not create shader.");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? "Unknown shader error.");
    }
    return shader;
}

export class ParticleEngine {
    private gl: WebGL2RenderingContext;
    private vbo: WebGLBuffer;
    private U = {} as Record<UniformName, WebGLUniformLocation | null>;
    private sampler = document.createElement("canvas");
    private reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    private maxPointSize: number;

    private opts: EngineOptions;
    private chars: string[];
    private atlas: WebGLTexture | null = null;
    private source: HTMLImageElement | null = null;

    private cols = 1;
    private rows = 1;
    private count = 0;
    private finishTime = 0;
    private cells = new Float32Array(0); // brightness of every cell - used by toText

    private startTime = 0;
    private settled = true;
    private raf = 0;
    private dirtyParticles = false;
    private dirtyAtlas = true;
    private dirtyLayout = true;

    constructor(private canvas: HTMLCanvasElement, options: Partial<EngineOptions> = {}) {
        this.opts = { ...DEFAULTS, ...options };
        this.chars = normalizeCharacters(this.opts.characters);
        if (this.chars.length === 0) {
            this.opts.characters = DEFAULTS.characters;
            this.chars = normalizeCharacters(DEFAULTS.characters);
        }

        const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
        if (!gl) throw new Error("Your browser does not support WebGL2.");
        this.gl = gl;

        const program = gl.createProgram();
        if (!program) throw new Error("Could not create program.");
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program) ?? "Link error.");
        }
        gl.useProgram(program);
        for (const name of UNIFORM_NAMES) this.U[name] = gl.getUniformLocation(program, name);

        // one buffer holds everything - each attribute reads its slice of it
        gl.bindVertexArray(gl.createVertexArray());
        const vbo = gl.createBuffer();
        if (!vbo) throw new Error("Could not create buffer.");
        this.vbo = vbo;
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        const attributes: [string, number, number][] = [
            ["aStartN", 2, 0], ["aGrid", 2, 8], ["aDelay", 1, 16],
            ["aB", 1, 20], ["aSeed", 1, 24], ["aRgb", 3, 28],
        ];
        for (const [name, size, offset] of attributes) {
            const loc = gl.getAttribLocation(program, name);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, offset);
        }

        gl.uniform1f(this.U.uDecay, this.opts.damping);
        gl.uniform1f(this.U.uOsc, this.opts.oscillation);
        gl.uniform1i(this.U.uAtlas, 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.maxPointSize = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1] || 64;
    }

    get hasImage() {
        return this.source !== null;
    }

    setImage(img: HTMLImageElement, animate = true) {
        this.source = img;
        this.dirtyParticles = true;
        this.settled = !animate || this.reduceMotion;
        this.startTime = performance.now();
        this.schedule();
    }

    // change options while running. brightness and colour mode only change a uniform
    // the rest has to rebuild something
    update(patch: Partial<EngineOptions>) {
        const prev = this.opts;
        const next = { ...prev, ...patch };

        if (patch.characters !== undefined) {
            const chars = normalizeCharacters(patch.characters);
            if (chars.length === 0) {
                next.characters = prev.characters; // empty input - keep the old characters
            } else {
                this.chars = chars;
                this.dirtyAtlas = true;
            }
        }

        if (
            next.particleCount !== prev.particleCount ||
            next.threshold !== prev.threshold ||
            next.gamma !== prev.gamma
        ) {
            this.dirtyParticles = true;
            this.settled = true; // show the finished picture while a slider is moving
        }
        if (next.glyphScale !== prev.glyphScale) this.dirtyLayout = true;

        this.opts = next;
        this.schedule();
    }

    replay() {
        this.settled = this.reduceMotion;
        this.startTime = performance.now();
        this.schedule();
    }

    resize() {
        this.dirtyLayout = true;
        this.schedule();
    }

    async toPNG(maxSide = 2400): Promise<Blob> {
        if (!this.source) throw new Error("Load an image first.");
        this.processDirty();

        // draw the finished picture on a bigger canvas - with a margin of one cell
        const cell = Math.max(2, Math.floor(maxSide / (Math.max(this.cols, this.rows) + 2)));
        const W = (this.cols + 2) * cell;
        const H = (this.rows + 2) * cell;
        this.applyLayout(W, H, cell, cell, cell);
        this.draw(SETTLED_TIME);
        const blob = await new Promise<Blob | null>((done) => this.canvas.toBlob(done, "image/png"));

        this.dirtyLayout = true; // go back to the normal size on the next frame
        this.schedule();
        if (!blob) throw new Error("Could not create the PNG.");
        return blob;
    }

    // letters are about twice as tall as wide - so two rows of cells become one line of text
    toText() {
        if (!this.source) return "";
        this.processDirty();
        const n = this.chars.length;
        const lines: string[] = [];
        for (let y = 0; y < this.rows; y += 2) {
            let line = "";
            for (let x = 0; x < this.cols; x++) {
                const top = this.cells[y * this.cols + x];
                const bottom = y + 1 < this.rows ? this.cells[(y + 1) * this.cols + x] : top;
                const v = (top + bottom) / 2;
                line += v < this.opts.threshold ? " " : this.chars[Math.min(n - 1, Math.floor(v * n))];
            }
            lines.push(line.trimEnd());
        }
        return lines.join("\n");
    }

    //internals

    private schedule() {
        if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    }

    private frame = (now: number) => {
        this.raf = 0;
        this.processDirty();
        const t = this.settled ? SETTLED_TIME : (now - this.startTime) / 1000;
        this.draw(t);
        // stop looping once everything landed - saves battery
        if (!this.settled && t < this.finishTime) this.schedule();
    };

    private processDirty() {
        if (this.dirtyParticles) {
            this.rebuildParticles();
            this.dirtyParticles = false;
            this.dirtyLayout = true;
        }
        if (this.dirtyAtlas) {
            this.rebuildAtlas();
            this.dirtyAtlas = false;
        }
        if (this.dirtyLayout) {
            this.layoutDisplay();
            this.dirtyLayout = false;
        }
    }

    private draw(t: number) {
        const { gl, U } = this;
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(U.uTime, t);
        gl.uniform1f(U.uGain, this.opts.brightness);
        gl.uniform1f(U.uChars, this.chars.length);
        gl.uniform1f(U.uColorMode, this.opts.colorMode === "color" ? 1 : 0);
        gl.drawArrays(gl.POINTS, 0, this.count);
    }

    private layoutDisplay() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
        const H = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
        const cell = Math.min((W * 0.94) / this.cols, (H * 0.92) / this.rows);
        this.applyLayout(W, H, cell, (W - cell * this.cols) / 2, (H - cell * this.rows) / 2);
    }

    private applyLayout(W: number, H: number, cell: number, offX: number, offY: number) {
        const { gl, U } = this;
        this.canvas.width = W;
        this.canvas.height = H;
        gl.viewport(0, 0, W, H);
        gl.uniform2f(U.uRes, W, H);
        gl.uniform2f(U.uOff, offX, offY);
        gl.uniform1f(U.uCell, cell);
        const size = Math.max(2, Math.round(cell * this.opts.glyphScale));
        gl.uniform1f(U.uSize, Math.min(size, this.maxPointSize));
    }

    // cut the image into cells - every cell that is bright enough becomes a particle
    private rebuildParticles() {
        const { gl, opts } = this;
        const img = this.source;
        if (!img) {
            this.count = 0;
            this.cells = new Float32Array(0);
            return;
        }

        const aspect = img.naturalWidth / img.naturalHeight;
        this.rows = Math.max(1, Math.round(Math.sqrt(opts.particleCount / aspect)));
        this.cols = Math.max(1, Math.round(this.rows * aspect));
        const { cols, rows } = this;

        // draw the image tiny on a hidden canvas - the browser averages the pixels for us
        this.sampler.width = cols;
        this.sampler.height = rows;
        const ctx = this.sampler.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("2D canvas is not available.");
        ctx.fillStyle = "#000"; // transparent parts count as black
        ctx.fillRect(0, 0, cols, rows);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, cols, rows);
        const px = ctx.getImageData(0, 0, cols, rows).data;

        this.cells = new Float32Array(cols * rows);
        const buffer = new Float32Array(cols * rows * FLOATS);
        let count = 0;
        let maxDelay = 0;

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = (y * cols + x) * 4;
                const r = px[i] / 255;
                const g = px[i + 1] / 255;
                const bl = px[i + 2] / 255;

                // colour to gray: weighted so green counts most
                let b = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
                b = Math.min(1, Math.max(0, (b - 0.04) / 0.92)); // stretch the contrast a bit
                b = Math.pow(b, opts.gamma);
                this.cells[y * cols + x] = b;
                if (b < opts.threshold) continue;

                // the further right a cell is - the later it starts moving
                const delay = this.reduceMotion
                    ? 0
                    : opts.startDelay + (x / cols) * opts.sweepDuration + Math.random() * 0.5;
                maxDelay = Math.max(maxDelay, delay);

                const o = count * FLOATS;
                buffer[o] = Math.random(); // random start position
                buffer[o + 1] = Math.random();
                buffer[o + 2] = x;
                buffer[o + 3] = y;
                buffer[o + 4] = delay;
                buffer[o + 5] = b;
                buffer[o + 6] = Math.random(); // seed - makes every particle move a bit differently
                buffer[o + 7] = r;
                buffer[o + 8] = g;
                buffer[o + 9] = bl;
                count++;
            }
        }

        this.count = count;
        this.finishTime = maxDelay + 4.5;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, buffer.subarray(0, count * FLOATS), gl.STATIC_DRAW);
    }

    // all characters go side by side into one texture - the shader picks the right slice
    private rebuildAtlas() {
        const { gl, chars } = this;
        const GLYPH = 32;
        const c = document.createElement("canvas");
        c.width = GLYPH * chars.length;
        c.height = GLYPH;
        const g = c.getContext("2d");
        if (!g) throw new Error("2D canvas is not available.");
        g.fillStyle = "#fff";
        g.font = `bold ${Math.round(GLYPH * 0.85)}px "Courier New", monospace`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        chars.forEach((ch, i) => {
            g.save();
            g.translate(GLYPH * i + GLYPH / 2, GLYPH / 2);
            g.scale(1.4, 1); // a little wider than normal
            g.fillText(ch, 0, 0);
            g.restore();
        });

        if (this.atlas) gl.deleteTexture(this.atlas);
        this.atlas = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.atlas);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
}