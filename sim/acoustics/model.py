"""Shared constants. Mirrors web/src/acoustics/model.ts: change both together."""

FS = 16_000
TICK_S = 0.01
BLOCK = 160  # samples per 10 ms tick
C = 343.0
REF_PA = 20e-6
GROUND_GAMMA = 0.7
N_HARM = 10
ROTOR_OFFSETS = [-0.006, 0.004, -0.002, 0.008]
PHASE_STEP = 0.6180339887498949
ARRAY_HALF_M = 0.06
ARRAY_MIC_H_M = 1.5
DETECTOR_MIC_H_M = 0.3
ARRAY_OFFSETS = [(-1, -1), (1, -1), (-1, 1), (1, 1)]
SELF_NOISE_DB = 29

# Blade-pass frequency (Hz) and level (dB SPL at 1 m). ASSUMED typical values, as in the TypeScript engine.
CLASS = {"fpv": (600.0, 85.0), "mini": (250.0, 80.0), "matrice": (100.0, 80.0)}
# Relative std of the rotor-speed wobble. ASSUMED from doc 03 (GPS hover 0.6 to 3 %).
WOBBLE = {"fpv": 0.02, "mini": 0.015, "matrice": 0.006}

# ISO 9613-1 absorption, roughly 20 C / 70 % RH, dB/km.
ABS_F = [0, 125, 250, 500, 1000, 2000, 4000, 8000]
ABS_DB_KM = [0, 0.4, 1.0, 1.9, 3.7, 9.7, 32.8, 117.0]
AIR_TAPS = 32
AIR_GRID_M = 20.0
AIR_MAX_M = 8000.0
AIR_DESIGN_N = 512
