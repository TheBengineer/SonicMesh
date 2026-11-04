"""Rate-1/2, K=7 convolutional code (171, 133 octal) with soft Viterbi, plus an interleaver."""
import numpy as np

K = 7
N_STATES = 1 << (K - 1)
TAIL = K - 1
_G = (0o171, 0o133)


def _parity(x):
    return bin(x).count("1") & 1


# register = (new bit << 6) | state; next state = register >> 1
_OUT = np.array([[[_parity(((b << 6) | s) & g) for g in _G] for b in (0, 1)] for s in range(N_STATES)])
_NS = np.arange(N_STATES)
_PREV = np.stack([(_NS & 31) << 1, ((_NS & 31) << 1) | 1], axis=1)   # predecessors of each state
_BIT = _NS >> 5                                                     # input bit that led there
# expected +-1 symbols on the branch from each predecessor into each state
_SIGN = 1 - 2 * np.stack([_OUT[_PREV[:, k], _BIT] for k in (0, 1)], axis=1)  # (state, pred, 2)


def encode(bits):
    state, out = 0, []
    for b in list(bits) + [0] * TAIL:
        out.extend(_OUT[state, b])
        state = ((b << 6) | state) >> 1
    return np.array(out, dtype=np.int8)


def decode(soft):
    """soft: per coded bit, positive = 0, negative = 1, magnitude = confidence."""
    soft = np.asarray(soft, dtype=float).reshape(-1, 2)
    pm = np.full(N_STATES, -1e18)
    pm[0] = 0.0
    choices = np.zeros((len(soft), N_STATES), dtype=np.int8)
    for t, r in enumerate(soft):
        cand = pm[_PREV] + _SIGN @ r                    # (state, pred)
        choices[t] = np.argmax(cand, axis=1)
        pm = cand[_NS, choices[t]]
    state, bits = 0, []
    for t in range(len(soft) - 1, -1, -1):
        bits.append(int(_BIT[state]))
        state = int(_PREV[state, choices[t, state]])
    return bits[::-1][:-TAIL]


def interleaver(n, seed=0x5EED):
    return np.random.default_rng(seed).permutation(n)
