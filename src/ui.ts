import { CHARACTER_PRESETS, DEFAULTS, type ColorMode, type EngineOptions } from "./config";
import { ParticleEngine } from "./engine";
import sampleUrl from "./sample.jpg";

type RangeKey = "particleCount" | "brightness" | "gamma" | "threshold" | "glyphScale";

function $<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el as T;
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Could not read that image."));
        img.src = src;
    });
}

function download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initApp(): void {
    const canvas = $<HTMLCanvasElement>("scene");
    const original = $<HTMLImageElement>("original");
    const toastEl = $("toast");
    const drop = $("drop");

    let engine: ParticleEngine;
    try {
        engine = new ParticleEngine(canvas);
    } catch (e) {
        toastEl.textContent = (e as Error).message;
        toastEl.classList.add("on");
        return;
    }

    let toastTimer: number | undefined;
    const toast = (msg: string): void => {
        toastEl.textContent = msg;
        toastEl.classList.add("on");
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => toastEl.classList.remove("on"), 2200);
    };

    // image loading
    let objectUrl: string | null = null;
    let baseName = "particle-portrait";

    async function show(src: string, name: string, owned: boolean): Promise<void> {
        try {
            const img = await loadImage(src);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            objectUrl = owned ? src : null;
            baseName = name;
            original.src = src;
            engine.setImage(img, true);
        } catch (e) {
            if (owned) URL.revokeObjectURL(src);
            toast((e as Error).message);
        }
    }

    function loadFile(file: File | undefined): void {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            toast("That file is not an image.");
            return;
        }
        const name = file.name.replace(/\.[^.]+$/, "") || "image";
        void show(URL.createObjectURL(file), name, true);
    }

    const fileInput = $<HTMLInputElement>("file");
    $("choose").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        loadFile(fileInput.files?.[0]);
        fileInput.value = "";
    });

    // drag and drop - whole window
    let dragDepth = 0;
    const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    window.addEventListener("dragenter", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        drop.classList.add("on");
    });
    window.addEventListener("dragover", (e) => {
        if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener("dragleave", (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) drop.classList.remove("on");
    });
    window.addEventListener("drop", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        drop.classList.remove("on");
        loadFile(e.dataTransfer?.files[0]);
    });

    // sliders
    const formats: Record<RangeKey, (v: number) => string> = {
        particleCount: (v) => v.toLocaleString("en-US"),
        brightness: (v) => v.toFixed(2),
        gamma: (v) => v.toFixed(2),
        threshold: (v) => v.toFixed(3),
        glyphScale: (v) => v.toFixed(2),
    };
    (Object.keys(formats) as RangeKey[]).forEach((key) => {
        const input = $<HTMLInputElement>(key);
        const out = $(`${key}-out`);
        input.value = String(DEFAULTS[key]);
        out.textContent = formats[key](DEFAULTS[key]);
        input.addEventListener("input", () => {
            const v = Number(input.value);
            out.textContent = formats[key](v);
            engine.update({ [key]: v } as Partial<EngineOptions>);
        });
    });

    // characters
    const presetSel = $<HTMLSelectElement>("preset");
    const charsInput = $<HTMLInputElement>("characters");
    CHARACTER_PRESETS.forEach((p, i) => presetSel.add(new Option(p.label, String(i))));
    presetSel.add(new Option("Custom", "custom"));
    const applyChars = (value: string): void => {
        engine.update({ characters: value });
    };
    charsInput.value = DEFAULTS.characters;
    presetSel.value = "0";
    presetSel.addEventListener("change", () => {
        const preset = CHARACTER_PRESETS[Number(presetSel.value)];
        if (!preset) return;
        charsInput.value = preset.value;
        applyChars(preset.value);
    });
    charsInput.addEventListener("input", () => {
        presetSel.value = "custom";
        applyChars(charsInput.value);
    });

    // output mode - grayscale / color
    const caption = $("result-caption");
    let currentMode: ColorMode = "grayscale";
    const setMode = (mode: ColorMode): void => {
        currentMode = mode;
        engine.update({ colorMode: mode });
        caption.textContent = mode === "color" ? "Color characters" : "Grayscale characters";
        document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => {
            r.checked = r.value === mode;
        });
        try {
            const url = new URL(location.href);
            if (mode === "color") url.searchParams.set("mode", "color");
            else url.searchParams.delete("mode");
            history.replaceState(null, "", url);
        } catch {
            /* e.g. file:// - ignore */
        }
    };
    document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) =>
        r.addEventListener("change", () => r.checked && setMode(r.value as ColorMode)),
    );
    setMode(new URLSearchParams(location.search).get("mode") === "color" ? "color" : "grayscale");

    // actions
    $("replay").addEventListener("click", () => engine.replay());
    $("save-png").addEventListener("click", async () => {
        if (!engine.hasImage) return;
        try {
            const suffix = currentMode === "color" ? "color" : "gray";
            download(await engine.toPNG(), `${baseName}-ascii-${suffix}.png`);
            toast("PNG saved");
        } catch (e) {
            toast((e as Error).message);
        }
    });
    $("save-txt").addEventListener("click", () => {
        if (!engine.hasImage) return;
        download(new Blob([engine.toText()], { type: "text/plain;charset=utf-8" }), `${baseName}-ascii.txt`);
        toast("Text saved");
    });
    $("copy-txt").addEventListener("click", async () => {
        if (!engine.hasImage) return;
        try {
            await navigator.clipboard.writeText(engine.toText());
            toast("Copied to clipboard");
        } catch {
            toast("Copy is blocked here. Use Save .txt instead.");
        }
    });
    window.addEventListener("keydown", (e) => {
        const tag = (e.target as HTMLElement | null)?.tagName ?? "";
        if (e.code === "Space" && !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) {
            e.preventDefault();
            engine.replay();
        }
    });

    // layout
    new ResizeObserver(() => engine.resize()).observe(canvas);

    void show(sampleUrl, "sample", false);
}