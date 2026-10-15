//! NumPy's default random generator, bit for bit: `np.random.default_rng(seed)` (SeedSequence and
//! PCG64) and `rng.random(n, dtype=np.float32)`. GAME's segmenter draws its noise from it in the
//! auto-tuner PoC, so the same seed gives the same notes here.

const INIT_A: u32 = 0x43b0_d7e5;
const MULT_A: u32 = 0x931e_8875;
const INIT_B: u32 = 0x8b51_f9dd;
const MULT_B: u32 = 0x58f3_8ded;
const MIX_MULT_L: u32 = 0xca01_f9dd;
const MIX_MULT_R: u32 = 0x4973_f715;
const XSHIFT: u32 = 16;
const POOL_SIZE: usize = 4;
const MULTIPLIER: u128 = 0x2360_ED05_1FC6_5DA4_4385_DF64_9FCC_F645;

fn hashmix(value: u32, hash_const: &mut u32) -> u32 {
    let mut value = value ^ *hash_const;
    *hash_const = hash_const.wrapping_mul(MULT_A);
    value = value.wrapping_mul(*hash_const);
    value ^ (value >> XSHIFT)
}

fn mix(x: u32, y: u32) -> u32 {
    let result = MIX_MULT_L.wrapping_mul(x).wrapping_sub(MIX_MULT_R.wrapping_mul(y));
    result ^ (result >> XSHIFT)
}

/// `np.random.SeedSequence(seed).generate_state(words, np.uint32)` for a seed below 2³².
fn seed_state(seed: u32, words: usize) -> Vec<u32> {
    let entropy = [seed];
    let mut pool = [0u32; POOL_SIZE];
    let mut hash_const = INIT_A;
    for (i, slot) in pool.iter_mut().enumerate() {
        *slot = hashmix(entropy.get(i).copied().unwrap_or(0), &mut hash_const);
    }
    for src in 0..POOL_SIZE {
        for dst in 0..POOL_SIZE {
            if src != dst {
                pool[dst] = mix(pool[dst], hashmix(pool[src], &mut hash_const));
            }
        }
    }
    let mut hash_const = INIT_B;
    (0..words)
        .map(|i| {
            let mut value = pool[i % POOL_SIZE] ^ hash_const;
            hash_const = hash_const.wrapping_mul(MULT_B);
            value = value.wrapping_mul(hash_const);
            value ^ (value >> XSHIFT)
        })
        .collect()
}

/// NumPy's PCG64 bit generator, with its buffered 32-bit outputs.
pub struct Generator {
    state: u128,
    inc: u128,
    spare: Option<u32>,
}

impl Generator {
    /// `np.random.default_rng(seed)`.
    pub fn new(seed: u32) -> Self {
        let words = seed_state(seed, 8);
        let word = |i: usize| u64::from(words[2 * i]) | (u64::from(words[2 * i + 1]) << 32);
        let initstate = (u128::from(word(0)) << 64) | u128::from(word(1));
        let initseq = (u128::from(word(2)) << 64) | u128::from(word(3));
        let mut rng = Self { state: 0, inc: (initseq << 1) | 1, spare: None };
        rng.step();
        rng.state = rng.state.wrapping_add(initstate);
        rng.step();
        rng
    }

    fn step(&mut self) {
        self.state = self.state.wrapping_mul(MULTIPLIER).wrapping_add(self.inc);
    }

    fn next_u64(&mut self) -> u64 {
        self.step();
        let xored = ((self.state >> 64) as u64) ^ (self.state as u64);
        xored.rotate_right((self.state >> 122) as u32)
    }

    fn next_u32(&mut self) -> u32 {
        if let Some(spare) = self.spare.take() {
            return spare;
        }
        let next = self.next_u64();
        self.spare = Some((next >> 32) as u32);
        next as u32
    }

    /// `rng.random(n, dtype=np.float32)`: uniform in [0, 1) with 24 random bits each.
    pub fn floats(&mut self, n: usize) -> Vec<f32> {
        (0..n).map(|_| (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_like_numpy() {
        // np.random.SeedSequence(0).generate_state(8, np.uint32)
        assert_eq!(seed_state(0, 8), vec![2968811710, 3677149159, 745650761, 2884920346, 2642120001, 549907821, 574372308, 742431198]);
        // np.random.default_rng(0).bit_generator.state
        let rng = Generator::new(0);
        assert_eq!(rng.state, 35399562948360463058890781895381311971);
        assert_eq!(rng.inc, 87136372517582989555478159403783844777);
    }

    #[test]
    fn draws_float32_like_numpy() {
        // np.random.default_rng(0).random((1, 5), dtype=np.float32)
        let floats = Generator::new(0).floats(5);
        assert_eq!(floats, vec![0.8506242, 0.63696164, 0.5111365, 0.26978666, 0.30782938]);
        // Two draws in a row carry the spare half of a 64-bit output over, as NumPy does:
        // rng.random((1, 3)) then rng.random((1, 4)).
        let mut rng = Generator::new(0);
        assert_eq!(rng.floats(3), vec![0.8506242, 0.63696164, 0.5111365]);
        assert_eq!(rng.floats(4), vec![0.26978666, 0.30782938, 0.040973485, 0.075240135]);
    }
}
