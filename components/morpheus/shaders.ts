/**
 * GLSL shared by the cockpit's shader materials.
 *
 * Hand-rolled value noise rather than a library: it is a few lines, it keeps
 * the bundle free of a noise dependency, and both the nebula and the core need
 * the *same* field so the world feels like one substance.
 */

export const NOISE = /* glsl */ `
  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(
        mix(hash(i + vec3(0.0, 0.0, 0.0)), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x),
        f.y
      ),
      mix(
        mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x),
        f.y
      ),
      f.z
    );
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }
`;

/** The sky: an inside-out sphere of slowly churning cloud. */
export const NEBULA_VERT = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const NEBULA_FRAG = /* glsl */ `
  varying vec3 vPos;
  uniform float uTime;
  uniform float uEnergy;
  uniform vec3 uBase;
  uniform vec3 uAccent;
  ${NOISE}

  void main() {
    vec3 d = normalize(vPos);

    // Two fields drifting at different rates so the sky never visibly loops.
    float n1 = fbm(d * 2.1 + vec3(0.0, uTime * 0.016, uTime * 0.011));
    float n2 = fbm(d * 4.7 - vec3(uTime * 0.009, 0.0, uTime * 0.013));

    vec3 deep = vec3(0.004, 0.009, 0.024);
    vec3 teal = mix(vec3(0.020, 0.105, 0.170), uBase, 0.28);
    vec3 violet = mix(vec3(0.075, 0.030, 0.180), uAccent, 0.12);

    vec3 col = mix(deep, teal, smoothstep(0.42, 0.82, n1) * 0.72);
    col = mix(col, violet, smoothstep(0.54, 0.91, n2) * 0.38);

    // Narrow aurora veils keep the sky surreal without turning it into the
    // muddy all-over gradient the previous background produced.
    float veil = pow(max(n1 - 0.64, 0.0), 2.4);
    col += veil * uAccent * (1.6 + uEnergy * 1.4);

    // Stable sub-pixel stars, with only a few bright enough to compete with
    // the core. The direction keeps them fixed to the celestial sphere while
    // the camera drifts.
    vec3 starCell = floor(d * 520.0);
    float starSeed = hash(starCell);
    float star = smoothstep(0.9968, 1.0, starSeed);
    float starPulse = 0.72 + 0.28 * sin(uTime * (0.7 + starSeed * 1.8) + starSeed * 31.0);
    col += star * starPulse * mix(vec3(0.34, 0.68, 0.9), uAccent, 0.3) * 0.9;

    // Sink the poles so the horizon reads as a volume rather than a box.
    col *= 0.62 + 0.38 * (1.0 - abs(d.y));

    gl_FragColor = vec4(col, 1.0);
  }
`;

/**
 * The uniforms every core material shares.
 *
 * `uEnergy` is the *state* — idle, listening, speaking — eased over about a
 * second. The four voice uniforms are the *sound*, updated every frame from
 * the microphone. Keeping them separate is what lets the orb hold a calm
 * listening posture and still react instantly to a word.
 *
 * Declared once and interpolated into each shader so the JavaScript uniform
 * objects and the GLSL cannot drift apart.
 */
export const VOICE_UNIFORMS = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  uniform float uVoiceVolume;
  uniform float uBass;
  uniform float uMids;
  uniform float uTreble;
  uniform float uEmphasis;
`;

/** The core: a displaced, fresnel-rimmed body flowing with the voice. */
export const CORE_VERT = /* glsl */ `
  ${VOICE_UNIFORMS}
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  varying float vVoice;
  ${NOISE}

  void main() {
    vec3 dir = normalize(position);
    // Two non-parallel currents advect through one another. This is domain
    // warping, not an amplitude oscillator: the mass stays present while its
    // folds continually migrate like liquid ether.
    vec3 currentA = vec3(uTime * 0.34, -uTime * 0.23, uTime * 0.29);
    vec3 currentB = vec3(-uTime * 0.21, uTime * 0.31, -uTime * 0.24);
    float warp = fbm(dir * 1.75 + currentA);
    float n = fbm(dir * 2.45 + currentB + vec3(warp * 0.92));
    vNoise = n;
    vVoice = uVoiceVolume;
    float azimuth = atan(dir.z, dir.x);
    float polar = acos(clamp(dir.y, -1.0, 1.0));
    // Azimuth collapses to a single point at the poles. Full displacement
    // there makes every flowing band converge into the sharp crown and tail
    // the operator flagged. Ease deformation near the poles while leaving the
    // equatorial membrane fully fluid.
    float poleBand = smoothstep(0.0, 0.58, max(sin(polar), 0.0));
    float poleGuard = mix(0.16, 1.0, poleBand);

    // Three layers, because one amplitude driving one field reads as a sphere
    // being inflated rather than as a surface responding to a voice.
    //
    // Loudness roughens the whole surface; bass sends a travelling fold
    // around it; treble is fine chatter that only shows on sibilance.
    float loudness = sqrt(clamp(uVoiceVolume, 0.0, 1.0));
    float bass = sqrt(clamp(uBass, 0.0, 1.0));
    float mids = sqrt(clamp(uMids, 0.0, 1.0));
    float treble = sqrt(clamp(uTreble, 0.0, 1.0));
    float voiceDrive = clamp(
      loudness * 1.8 + bass * 0.55 + mids * 0.8 + uEmphasis * 1.15,
      0.0,
      2.8
    );
    float voiceNoise = (noise(position * 2.0 + currentA * 4.0) - 0.5) *
      (0.2 + voiceDrive * 1.12);
    float bassFlow = sin(azimuth * 3.0 + polar * 4.0 - uTime * 3.2) *
      bass * 0.72;
    float midsFold =
      sin(azimuth * 5.0 - polar * 2.0 + uTime * 4.8) * mids * 0.38;
    float trebleRipple =
      sin(dot(dir, vec3(11.0, 7.0, 13.0)) + uTime * 9.0) * treble * 0.16;
    float emphasisTear =
      pow(max(noise(dir * 7.0 - currentB * 5.0) - 0.46, 0.0), 1.7) *
      uEmphasis *
      1.65;

    // A slow six-lobed silhouette is what keeps the core organic at rest.
    // Noise alone averages into a fuzzy sphere from cockpit distance.
    float macro =
      sin(azimuth * 6.0 + sin(polar * 3.0) - uTime * 0.78 + warp * 1.3) * 0.68 +
      sin(polar * 5.0 + azimuth * 0.8 + uTime * 0.57) * 0.28;
    float flow =
      (n - 0.5) * (1.55 + uEnergy * 1.45) * mix(0.48, 1.0, poleBand) +
      macro * (1.12 + uEnergy * 0.34) * poleGuard;
    vec3 displaced =
      position +
      normal * (
        flow +
        (voiceNoise + bassFlow + midsFold + trebleRipple + emphasisTear) *
          mix(0.38, 1.0, poleBand)
      );

    vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const CORE_FRAG = /* glsl */ `
  ${VOICE_UNIFORMS}
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  varying float vVoice;

  void main() {
    // Keep the luminous skin narrow. A softer Fresnel exponent spreads light
    // across too much of the face and makes the membrane read as thick glass.
    float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 5.2);

    // Mids carry most of speech, so they are what pushes the body toward the
    // hot colour: the orb brightens on vowels rather than on any loud noise.
    float heat = smoothstep(0.35, 0.85, vNoise) + uMids * 0.45;
    vec3 body = mix(uColor, uHot, clamp(heat, 0.0, 1.0));

    // The body carries the colour and the rim carries the light. Weighting
    // the rim too heavily is what turned the orb into a grey ball: fresnel
    // uses the *hot* colour, so at high gain every surface washes to white.
    float lift =
      0.15 +
      uEnergy * 0.26 +
      vVoice * 0.52 +
      uMids * 0.2 +
      uEmphasis * 0.44;
    vec3 col =
      body * (lift + 0.03 + vNoise * 0.08) +
      fresnel * uHot *
        (0.58 + uEnergy * 0.44 + uTreble * 0.7 + uEmphasis * 1.1);

    // Filaments where the noise field peaks — the internal structure that
    // makes this read as something with contents rather than a shell.
    col += pow(max(vNoise - 0.66, 0.0), 1.6) * uHot * (2.2 + uEnergy * 2.0);
    col *= 2.12;

    // Mostly boundary and filament, barely any filled body. This keeps the
    // centre reading as moving ether rather than a glossy solid ball.
    float alpha =
      0.011 +
      smoothstep(0.52, 0.88, vNoise) * 0.046 +
      fresnel * 0.29 +
      pow(max(vNoise - 0.7, 0.0), 1.7) * 0.27;
    gl_FragColor = vec4(
      col,
      clamp(alpha + vVoice * 0.12 + uEmphasis * 0.14, 0.0, 0.82)
    );
  }
`;

/**
 * The floor: a wave field the orb stands on.
 *
 * The single biggest reason the cockpit read as "an object on a background"
 * rather than as a place. A ground plane gives the orb somewhere to be, and
 * because the waves are driven by the same four voice uniforms, the whole
 * room reacts rather than just the thing in the middle of it.
 *
 * Drawn as lines rather than as a surface: a lit surface needs shadows and a
 * light budget to read as anything, whereas additive lines read as a field of
 * data at no cost and match everything else on screen.
 */
export const FLOOR_VERT = /* glsl */ `
  ${VOICE_UNIFORMS}
  uniform float uLayer;
  varying vec2 vUv;
  varying float vHeight;
  varying float vDist;
  ${NOISE}

  void main() {
    vUv = uv;

    // Distance from the orb, used to sink the field away into the dark and to
    // let the waves break hardest directly underneath it.
    float d = length(position.xy);
    vDist = d;

    // Three travelling waves at different wavelengths, so the field never
    // visibly repeats, plus a slow noise swell underneath them.
    float w =
      sin(position.x * (0.13 + uLayer * 0.018) - uTime * (0.52 + uLayer * 0.08)) * 0.8 +
      sin(position.y * (0.18 + uLayer * 0.014) + uTime * (0.34 + uLayer * 0.07)) * 0.55 +
      sin((position.x + position.y) * (0.075 + uLayer * 0.01) + uTime * 0.25) * 0.9;

    w += (noise(vec3(position.xy * 0.07, uTime * 0.08)) - 0.5) * 1.6;

    // Voice lifts the whole field, and bass makes it swell from the centre
    // outward — the orb pushing the ground away when it speaks.
    float voice = 1.0 + uVoiceVolume * 2.2;
    float swell = uBass * 3.2 * exp(-d * 0.055) * sin(d * 0.22 - uTime * 2.2);
    float ripple = uTreble * 0.8 * sin(d * 0.9 - uTime * 6.0);

    float height = w * voice + swell + ripple;
    vHeight = height;

    vec3 displaced = position + vec3(0.0, 0.0, height);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

export const FLOOR_FRAG = /* glsl */ `
  ${VOICE_UNIFORMS}
  uniform float uLayer;
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec2 vUv;
  varying float vHeight;
  varying float vDist;

  void main() {
    // Contour lines across the field. The line is widened with distance by
    // hand rather than with fwidth(), which needs an extension on WebGL1 and
    // would silently give a black floor on the machines that lack it.
    float lines = vUv.y * (72.0 + uLayer * 11.0);
    float edge = abs(fract(lines) - 0.5);
    float width = 0.055 + vDist * 0.0022;
    float line = 1.0 - smoothstep(0.0, width, edge);

    // Crests catch the hot colour; troughs stay in the base.
    float crest = smoothstep(0.0, 4.0, vHeight);
    vec3 col = mix(uColor, uHot, crest * (0.4 + uVoiceVolume * 0.6));

    // Two fades, and the near one matters most. Without it the field runs up
    // under the camera and fills the frame, which is what turned the cockpit
    // into a landscape with an orb parked in it.
    float fade = 1.0 - smoothstep(34.0, 55.0, vDist);
    float near = smoothstep(23.0, 32.0, vDist);

    float layerFade = 0.78 - uLayer * 0.16;
    float alpha = line * fade * near * layerFade *
      (0.045 + uEnergy * 0.03 + uVoiceVolume * 0.3 + uMids * 0.14);
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(col * (0.8 + crest * 0.9), alpha);
  }
`;

/**
 * The vertical current: translucent filament cylinders joining the floor to
 * the core. The reference depends on this column to make the orb feel fed by
 * the room rather than parked above it.
 */
export const COLUMN_VERT = /* glsl */ `
  ${VOICE_UNIFORMS}
  varying vec2 vUv;
  varying float vPulse;
  ${NOISE}

  void main() {
    vUv = uv;
    float climb = fract(uv.y * 5.0 - uTime * (0.35 + uEnergy * 0.55));
    vPulse = smoothstep(0.72, 1.0, climb);

    vec3 displaced = position;
    float taper = smoothstep(0.0, 0.72, uv.y);
    float tremor = (noise(vec3(position.xz * 0.9, uTime * 0.35)) - 0.5) *
      (0.08 + uMids * 0.22);
    displaced.xz *= mix(1.0, 0.42, taper);
    displaced.xz += normalize(position.xz + vec2(0.0001)) * tremor;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

export const COLUMN_FRAG = /* glsl */ `
  ${VOICE_UNIFORMS}
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec2 vUv;
  varying float vPulse;

  void main() {
    float strands = pow(abs(sin(vUv.x * 3.14159265 * 18.0)), 9.0);
    float core = pow(abs(sin(vUv.x * 3.14159265 * 5.0)), 16.0);
    float floorFade = smoothstep(0.0, 0.12, vUv.y);
    float topFade = 1.0 - smoothstep(0.76, 1.0, vUv.y);
    float edge = floorFade * topFade;
    float activity = 0.32 + uEnergy * 0.42 + uVoiceVolume * 0.55;
    float alpha = (strands * 0.24 + core * 0.32 + vPulse * 0.18) * edge * activity;
    if (alpha < 0.004) discard;
    vec3 color = mix(uColor, uHot, clamp(vPulse + uTreble * 0.45, 0.0, 1.0));
    gl_FragColor = vec4(color * (1.0 + vPulse * 1.4), alpha);
  }
`;

/** A thin rim shell that hangs just outside the core and catches the light. */
export const SHELL_FRAG = /* glsl */ `
  ${VOICE_UNIFORMS}
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  varying float vVoice;

  void main() {
    // A tight rim. At 3.4 the falloff was wide enough to read as fog sitting
    // over the core rather than as an edge around it.
    float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 7.2);
    float alpha = fresnel * (0.1 + uEnergy * 0.19 + vVoice * 0.3);
    vec3 rim = mix(uColor, uHot, 0.7);
    gl_FragColor = vec4(rim * (1.2 + uEnergy * 0.62 + uBass * 0.7), alpha);
  }
`;

/** Uneven internal vapour: depth without another concentric luminous rim. */
export const VOLUME_FRAG = /* glsl */ `
  ${VOICE_UNIFORMS}
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  varying float vVoice;

  void main() {
    float facing = max(dot(vNormal, vView), 0.0);
    float wisps = smoothstep(0.48, 0.84, vNoise);
    float filaments = pow(max(vNoise - 0.64, 0.0), 1.7);
    vec3 col = mix(uColor, uHot, wisps * 0.7 + uMids * 0.22);
    col *= (0.62 + wisps * 1.15 + filaments * 2.7 + uEnergy * 0.4) * 1.32;
    float alpha =
      facing *
      (0.016 + wisps * 0.075 + filaments * 0.16 + vVoice * 0.055 + uEmphasis * 0.075);
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.3));
  }
`;
