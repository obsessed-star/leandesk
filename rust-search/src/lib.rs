//! Dependency-free, in-process BM25 index. Host supplies normalized term IDs
//! and approved tenant/scope groups; no document text or external I/O enters WASM.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

struct Posting {
    doc: usize,
    group: u32,
    frequency: f64,
}
struct Group {
    count: usize,
    length: u64,
}
struct Index {
    lengths: Vec<f64>,
    groups: HashMap<u32, Group>,
    postings: HashMap<u32, Vec<Posting>>,
}
thread_local! {
    static INPUT: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    static INDEX: RefCell<Option<Index>> = const { RefCell::new(None) };
}

#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn input_resize(length: u32) -> *mut u32 {
    if length > 8_000_000 {
        return std::ptr::null_mut();
    }
    INPUT.with(|input| {
        let mut data = input.borrow_mut();
        data.resize(length as usize, 0);
        data.as_mut_ptr()
    })
}

fn load(data: &[u32]) -> Option<Index> {
    let count = *data.first()? as usize;
    if count > 500_000 {
        return None;
    }
    let mut index = Index {
        lengths: Vec::with_capacity(count),
        groups: HashMap::new(),
        postings: HashMap::new(),
    };
    let mut cursor = 1;
    for doc in 0..count {
        let group = *data.get(cursor)?;
        let length = *data.get(cursor + 1)?;
        let terms = *data.get(cursor + 2)? as usize;
        cursor += 3;
        let end = cursor.checked_add(terms.checked_mul(2)?)?;
        let pairs = data.get(cursor..end)?;
        let mut seen = HashSet::new();
        let mut total = 0_u64;
        for pair in pairs.chunks_exact(2) {
            if pair[1] == 0 || !seen.insert(pair[0]) {
                return None;
            }
            total += u64::from(pair[1]);
            index.postings.entry(pair[0]).or_default().push(Posting {
                doc,
                group,
                frequency: f64::from(pair[1]),
            });
        }
        if total != u64::from(length) {
            return None;
        }
        cursor = end;
        index.lengths.push(f64::from(length));
        let stats = index.groups.entry(group).or_insert(Group {
            count: 0,
            length: 0,
        });
        stats.count += 1;
        stats.length += u64::from(length);
    }
    if cursor != data.len() {
        return None;
    }
    Some(index)
}

#[unsafe(no_mangle)]
pub extern "C" fn index_load() -> u32 {
    let parsed = INPUT.with(|input| load(&input.borrow()));
    INDEX.with(|index| {
        *index.borrow_mut() = parsed;
    });
    INDEX.with(|index| u32::from(index.borrow().is_some()))
}

impl Index {
    fn search(&self, data: &[u32]) -> Option<Vec<u32>> {
        let limit = (*data.first()? as usize).min(3);
        let group_count = *data.get(1)? as usize;
        let group_end = 2_usize.checked_add(group_count)?;
        let groups: HashSet<u32> = data.get(2..group_end)?.iter().copied().collect();
        let term_count = *data.get(group_end)? as usize;
        let terms = data.get(group_end + 1..)?;
        if terms.len() != term_count {
            return None;
        }
        let mut count = 0;
        let mut length = 0_u64;
        for group in &groups {
            if let Some(stats) = self.groups.get(group) {
                count += stats.count;
                length += stats.length;
            }
        }
        if limit == 0 || count == 0 || length == 0 {
            return Some(Vec::new());
        }
        let avg = length as f64 / count as f64;
        let mut scores: HashMap<usize, f64> = HashMap::new();
        let mut seen_terms = HashSet::new();
        for term in terms {
            if !seen_terms.insert(*term) {
                continue;
            }
            let Some(postings) = self.postings.get(term) else {
                continue;
            };
            // IDF uses authorized groups only, even when another tenant has
            // millions of matching documents in the same physical index.
            let df = postings
                .iter()
                .filter(|p| groups.contains(&p.group))
                .count();
            let idf = (1.0 + (count as f64 - df as f64 + 0.5) / (df as f64 + 0.5)).ln();
            for p in postings.iter().filter(|p| groups.contains(&p.group)) {
                let score = idf * p.frequency * 2.2
                    / (p.frequency + 1.2 * (0.25 + 0.75 * self.lengths[p.doc] / avg));
                *scores.entry(p.doc).or_default() += score;
            }
        }
        // Keep only the top three; ties preserve original document order.
        let mut best: Vec<(usize, f64)> = Vec::with_capacity(4);
        for (doc, score) in scores {
            if score <= 0.0 || !score.is_finite() {
                continue;
            }
            let at = best
                .iter()
                .position(|(other, value)| score > *value || (score == *value && doc < *other))
                .unwrap_or(best.len());
            if at < limit {
                best.insert(at, (doc, score));
                best.truncate(limit);
            }
        }
        let floor = best.first().map_or(0.0, |(_, score)| score * 0.55);
        Some(
            best.into_iter()
                .filter(|(_, score)| *score >= floor)
                .map(|(doc, _)| doc as u32)
                .collect(),
        )
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn search() -> u32 {
    let result =
        INDEX.with(|index| INPUT.with(|input| index.borrow().as_ref()?.search(&input.borrow())));
    OUTPUT.with(|output| {
        let mut out = output.borrow_mut();
        *out = result.unwrap_or_default();
        out.len() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> *const u32 {
    OUTPUT.with(|out| out.borrow().as_ptr())
}
