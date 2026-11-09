export const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 aStartN;  // where the particle starts (0..1)
in vec2 aGrid;    // its cell in the image
in float aDelay;  // when it starts moving
in float aB;      // brightness 0..1
in float aSeed;   // random number, different for every particle
in vec3 aRgb;     // original color

uniform vec2 uRes;
uniform vec2 uOff;
uniform float uCell;
uniform float uTime;
uniform float uSize;
uniform float uChars;
uniform float uGain;
uniform float uDecay;
uniform float uOsc;
uniform float uColorMode;  // 0 gray, 1 color

out float vIdx;
out vec3 vColor;

// before it starts moving a particle just floats around
vec2 drift(float t, vec2 start) {
    float p = t * 0.9 + aSeed * 6.2831853;
    vec2 wobble = vec2(sin(p * 1.7 + aSeed * 17.0), cos(p * 1.3 + aSeed * 11.0));
    return start + wobble * uCell * 1.5;
}

void main() {
    vec2 start = aStartN * uRes;
    vec2 target = uOff + (aGrid + 0.5) * uCell;
    float t = uTime - aDelay;

    vec2 pos;
    if (t < 0.0) {
        pos = drift(uTime, start);
    } else {
        // spring that slows down: goes to the target, overshoots a little, settles
        float damp = uDecay * (0.8 + 0.5 * aSeed);
        float k = exp(-damp * t) * (cos(uOsc * t) + (damp / uOsc) * sin(uOsc * t));
        pos = target + (drift(aDelay, start) - target) * k;
    }
    pos = floor(pos + 0.5); // snap to whole pixels

    gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
    gl_PointSize = uSize;
    vIdx = min(uChars - 1.0, floor(aB * uChars));

    float level = (0.3 + 0.7 * aB) * uGain;
    float peak = max(max(aRgb.r, aRgb.g), max(aRgb.b, 0.001));
    vec3 tint = aRgb / peak; // same hue, brightest channel at 1
    vColor = mix(vec3(clamp(level, 0.0, 1.0)), clamp(tint * level, 0.0, 1.0), uColorMode);
}`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uAtlas;
uniform float uChars;

in float vIdx;
in vec3 vColor;
out vec4 outColor;

void main() {
    // pick this character's slice out of the atlas
    vec2 uv = vec2((vIdx + gl_PointCoord.x) / uChars, gl_PointCoord.y);
    outColor = vec4(vColor, texture(uAtlas, uv).a);
}`;