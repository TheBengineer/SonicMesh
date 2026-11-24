# Deploy tones

During deployment the operator walks to each node with a phone. A web page on the phone plays a short
tone frame; the node's microphone decodes it; the node blinks and sends a TONE record over the radio;
the gateway logs it. The page logs the phone's GPS position with the same mark number, so the node's
id (from the radio record) and its position (from the phone) are joined afterwards by mark number.
This also proves, per node, that the microphone, the detector chain and the radio all work.

It is one way: the phone never hears back from the node, except that the operator sees the LED.
Commands other than MARK are reserved for later (settings by tone).

## Signal (version 1)

All numbers below are exact; the phone page, the Python reference (`firmware/tools/smtool/tones.py`)
and the firmware detector (`firmware/detectors/deploy_tones/`) must all match them.

- **Tones**: 8-FSK. Tone k (0..7) is `f_k = 1500 + 250 * k` Hz (1500 .. 3250 Hz). This band is flat
  (within 2 dB) through the node's microphone chain and well inside a phone speaker's range.
- **Symbol**: 48 ms of one tone, no gap. Each symbol's amplitude envelope has 4 ms raised-cosine ramps
  at both ends, so symbol boundaries do not click (a click could look like a gunshot onset).
- **Frame**: 12 symbols, 576 ms.
  - Symbols 0-3: preamble, tones `0, 7, 0, 7`.
  - Symbols 4-11: 24 bits, 3 bits per symbol, most significant first: the 16-bit word (big-endian,
    so bits 15..0) followed by CRC-8 of the word's two bytes (high byte first). CRC-8: polynomial
    0x07, initial value 0x00, no reflection, no final XOR (CRC-8/SMBUS; check value of ASCII
    "123456789" is 0xF4).
- **Send**: the page plays the frame 3 times with 250 ms of silence between, about 2.2 s in all.
- **Word**: bits 15..12 are the command, bits 11..0 the argument.
  - Command 1, MARK: argument = mark number 0..4095.
  - Commands 0 and 2..15: reserved. A node reports any frame whose CRC is good, but acts only on MARK.
- **Level**: the page plays at full scale; the operator holds the phone 0.5-2 m from the node.

## Decoder (node and Python reference, same algorithm)

Input: 16 kHz mono samples (the node's audio after its DC blocker), as int16 or float.

1. **Analysis windows**: 256 samples (16 ms) with a Hann window, hop 128 samples (8 ms). For each
   window compute the power `E_k` at each of the 8 tone frequencies (Goertzel at the exact frequency,
   not the nearest bin). Also the window's mean-square level.
2. **History**: keep the last 72 hops of `E_k` (a frame is 12 symbols x 6 hops). A symbol spans 6 hops;
   its decision uses only hops 1..4 of the 6 (the middle 32 ms) to stay clear of the boundaries.
3. **Frame test at every hop**, for the 72 hops ending now, symbol i covering hops `6i .. 6i+5`:
   - Per symbol: `S_k = sum of E_k over hops 6i+1 .. 6i+4`. Decision `d_i = argmax_k S_k`.
     Dominance `r_i = S_max / (mean of the other 7 S_k)`.
   - Accept only if the preamble decisions are exactly `0, 7, 0, 7`, every one of the 12 symbols has
     `r_i >= 6.0` (7.8 dB), and the CRC of the decoded word is good.
   The first passing test is usually a few hops early (it can be up to 28 ms early), so do not
   report it at once: keep testing the next 5 hops as well, and of the passing tests among these 6
   take the one with the highest minimum dominance (the earliest on a tie). Its hop 0 is the frame
   start. With this the start is within one hop (8 ms).
4. **On accept**: report the word, the frame start (time of the first sample of hop 0 of the frame),
   the tone level (mean of `S_max` over the 12 symbols, as dB relative to full-scale sine; the node
   converts to dB SPL with its `audio.full_scale_db`) and the dominance (the minimum `r_i`, in dB).
   Then ignore frame tests until 71 hops after the chosen test's hop, so one frame is reported once.
5. **Repeats**: the same word within 5 s of the last report of that word is not reported again (the
   page plays each frame 3 times). The Python reference does the same, so its output matches the node.

Hop alignment: frames start at any sample, and the 8 ms hop means the frame test sees a symbol up to
4 ms (half a hop) early or late; the middle-four-hops rule keeps the decision window inside the symbol
in that worst case (the 4 ms ramps are outside it too).

## Node behaviour

- The decoder is a detector like the others (`SM_DETECTOR_DEFINE(deploy_tones, ...)`), priority 4,
  with parameters `deploy_tones.enable` (1), `deploy_tones.min_ratio_db` (7.8) and
  `deploy_tones.repeat_ms` (5000), and trace stream `tones` (level 1: each report; level 2: every
  frame test that passed the preamble).
- On a report: send a TONE record and flash the green LED three times (3 x 100 ms on, 100 ms off).
- TONE record, type `0x12`, timed (`sm_msg_send_timed`, t = frame start):
  - `word`       u16  the decoded word
  - `level_db10` i16  tone level, dB SPL x10
  - `ratio_db10` i16  minimum dominance over the 12 symbols, dB x10

## Joining marks and positions

The page keeps a log (mark, phone time ISO 8601, latitude, longitude, accuracy m) and exports it as
JSON. `sm tones merge --phone marks.json --log smlog-*.jsonl` matches each TONE record with command
MARK to the phone entry with the same mark number (nearest in time if a number was reused), and writes
`nodes.json`: node id, mark, latitude, longitude, accuracy, tone level, dominance.
