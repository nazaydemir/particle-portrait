export type ColorMode = "grayscale" | "color";

export interface EngineOptions {
    particleCount: number; // roughly how many cells the image is cut into
    characters: string; // dark -> light
    threshold: number; // cells darker than this are skipped (0..1)
    brightness: number;
    gamma: number; // below 1 lifts the shadows
    glyphScale: number; // glyph size compared to its cell
    colorMode: ColorMode;
    sweepDuration: number; // seconds for the left-to-right reveal
    startDelay: number; // seconds before anything moves
    damping: number; // higher = particles settle faster
    oscillation: number; // overshoot speed while settling
}

export const DEFAULTS: EngineOptions = {
    particleCount: 14000,
    characters: ".:-=+*#%@",
    threshold: 0.01,
    brightness: 1.8,
    gamma: 0.85,
    glyphScale: 1.25,
    colorMode: "grayscale",
    sweepDuration: 2.4,
    startDelay: 0.6,
    damping: 2.4,
    oscillation: 4.0,
};

//character presets for the UI dropdown
export const CHARACTER_PRESETS: { label: string; value: string }[] = [
    { label: "Classic", value: ".:-=+*#%@" },
    { label: "Detailed", value: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$" },
    { label: "Minimal", value: ".oO@" },
    { label: "Blocks", value: " ░▒▓█" },
    { label: "Binary", value: "01" },
];