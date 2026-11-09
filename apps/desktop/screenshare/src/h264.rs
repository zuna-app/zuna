//! Readies an encoder's H.264 access units for LiveKit's frame encryption.
//!
//! The frame cryptor finds NAL units by their start codes, so it wants them all
//! four bytes long, and it leaves everything in the clear up to one byte past the
//! first slice's NAL header. Chromium reads `pic_parameter_set_id` from that clear
//! part before decrypting. Some encoders write `slice_type` 7 on IDR slices, which
//! takes seven bits and pushes that field out of the clear byte, so Chromium reads a
//! random bit and drops about half of the keyframes
//! (<https://github.com/livekit/rust-sdks/issues/1573>). `slice_type` 2 means the same
//! thing for a single-slice picture and takes three bits, which brings it back in.
//! NVENC already writes 2, so this leaves its keyframes as they are.

use std::collections::HashMap;

const NAL_SLICE_IDR: u8 = 5;
const NAL_SEI: u8 = 6;
const NAL_SPS: u8 = 7;
const NAL_PPS: u8 = 8;
const NAL_AUD: u8 = 9;
const NAL_FILLER: u8 = 12;
const START_CODE: [u8; 4] = [0, 0, 0, 1];

#[derive(Clone, Debug)]
struct Sps {
    separate_colour_plane: bool,
    log2_max_frame_num: u32,
    poc_type: u32,
    log2_max_poc_lsb: u32,
    delta_pic_order_always_zero: bool,
    frame_mbs_only: bool,
}

#[derive(Clone, Debug)]
struct Pps {
    sps_id: u32,
    cabac: bool,
    bottom_field_pic_order: bool,
    deblocking_control_present: bool,
    redundant_pic_cnt_present: bool,
}

#[derive(Default)]
pub struct Rewriter {
    pub fix_idr: bool,
    sps: HashMap<u32, Sps>,
    pps: HashMap<u32, Pps>,
    pub idr_rewritten: u64,
    pub idr_left_alone: u64,
}

impl Rewriter {
    pub fn new(fix_idr: bool) -> Self {
        Self { fix_idr, ..Self::default() }
    }

    /// Appends the access unit to `out` with four-byte start codes, and without the
    /// NAL units that don't belong in a stream going to a decoder over the network.
    pub fn prepare(&mut self, access_unit: &[u8], out: &mut Vec<u8>) {
        for nal in nal_units(access_unit) {
            let Some(&header) = nal.first() else { continue };
            match header & 0x1f {
                NAL_AUD | NAL_SEI | NAL_FILLER => continue,
                NAL_SPS => self.read_sps(nal),
                NAL_PPS => self.read_pps(nal),
                _ => {}
            }
            out.extend_from_slice(&START_CODE);
            if self.fix_idr && header & 0x1f == NAL_SLICE_IDR {
                match self.rewrite_idr(nal) {
                    Some(rewritten) => {
                        self.idr_rewritten += 1;
                        out.extend_from_slice(&rewritten);
                        continue;
                    }
                    None => self.idr_left_alone += 1,
                }
            }
            out.extend_from_slice(nal);
        }
    }

    fn read_sps(&mut self, nal: &[u8]) {
        let rbsp = unescape(&nal[1..]);
        if let Some((id, sps)) = parse_sps(&rbsp) {
            self.sps.insert(id, sps);
        }
    }

    fn read_pps(&mut self, nal: &[u8]) {
        let rbsp = unescape(&nal[1..]);
        if let Some((id, pps)) = parse_pps(&rbsp) {
            self.pps.insert(id, pps);
        }
    }

    /// Returns the NAL unit with `slice_type` 2, or None if it doesn't need that or
    /// its parameter sets are unknown.
    fn rewrite_idr(&self, nal: &[u8]) -> Option<Vec<u8>> {
        let rbsp = unescape(&nal[1..]);
        let mut reader = BitReader::new(&rbsp);
        let first_mb = reader.ue()?;
        if reader.ue()? != 7 {
            return None;
        }
        let after_slice_type = reader.position;
        let pps = self.pps.get(&reader.ue()?)?;
        let sps = self.sps.get(&pps.sps_id)?;

        if sps.separate_colour_plane {
            reader.skip(2)?;
        }
        reader.skip(sps.log2_max_frame_num)?;
        let mut field_pic = false;
        if !sps.frame_mbs_only {
            field_pic = reader.bit()? == 1;
            if field_pic {
                reader.skip(1)?;
            }
        }
        reader.ue()?; // idr_pic_id
        match sps.poc_type {
            0 => {
                reader.skip(sps.log2_max_poc_lsb)?;
                if pps.bottom_field_pic_order && !field_pic {
                    reader.se()?;
                }
            }
            1 if !sps.delta_pic_order_always_zero => {
                reader.se()?;
                if pps.bottom_field_pic_order && !field_pic {
                    reader.se()?;
                }
            }
            _ => {}
        }
        if pps.redundant_pic_cnt_present {
            reader.ue()?;
        }
        reader.skip(2)?; // dec_ref_pic_marking on an IDR
        reader.se()?; // slice_qp_delta
        if pps.deblocking_control_present && reader.ue()? != 1 {
            reader.se()?;
            reader.se()?;
        }
        let header_end = reader.position;

        let mut writer = BitWriter::default();
        writer.ue(first_mb);
        writer.ue(2);
        writer.copy_bits(&rbsp, after_slice_type, header_end);

        if pps.cabac {
            // CABAC data starts on a byte boundary, marked by alignment bits of ones.
            while !writer.is_aligned() {
                writer.bit(1);
            }
            let data_start = header_end.div_ceil(8);
            writer.bytes.extend_from_slice(rbsp.get(data_start..)?);
        } else {
            // CAVLC data has no alignment, so all of it moves along with the header.
            let stop_bit = last_set_bit(&rbsp)?;
            writer.copy_bits(&rbsp, header_end, stop_bit + 1);
            while !writer.is_aligned() {
                writer.bit(0);
            }
        }

        let mut rewritten = Vec::with_capacity(nal.len());
        rewritten.push(nal[0]);
        escape(&writer.bytes, &mut rewritten);
        Some(rewritten)
    }
}

fn nal_units(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut position = find_start_code(data, 0).map(|at| at + 3);
    std::iter::from_fn(move || {
        let start = position?;
        let next = find_start_code(data, start);
        position = next.map(|at| at + 3);
        let mut end = next.unwrap_or(data.len());
        // The zeros before a start code are padding and not part of this NAL unit.
        while end > start && data[end - 1] == 0 {
            end -= 1;
        }
        Some(&data[start..end])
    })
}

fn find_start_code(data: &[u8], from: usize) -> Option<usize> {
    let mut at = from;
    while at + 3 <= data.len() {
        // Stepping by what the third byte rules out is what makes this quick to scan.
        match data[at + 2] {
            0 => at += 1,
            1 if data[at] == 0 && data[at + 1] == 0 => return Some(at),
            _ => at += 3,
        }
    }
    None
}

fn unescape(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut zeros = 0;
    for &byte in data {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

fn escape(data: &[u8], out: &mut Vec<u8>) {
    let mut zeros = 0;
    for &byte in data {
        if zeros >= 2 && byte <= 3 {
            out.push(3);
            zeros = 0;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    // A NAL unit can't end in a zero, which CABAC's padding words otherwise would.
    if data.last() == Some(&0) {
        out.push(3);
    }
}

fn last_set_bit(data: &[u8]) -> Option<usize> {
    let at = data.iter().rposition(|&byte| byte != 0)?;
    Some(at * 8 + 7 - data[at].trailing_zeros() as usize)
}

fn parse_sps(rbsp: &[u8]) -> Option<(u32, Sps)> {
    let mut reader = BitReader::new(rbsp);
    let profile = reader.bits(8)?;
    reader.skip(16)?;
    let id = reader.ue()?;

    let mut separate_colour_plane = false;
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
        let chroma_format = reader.ue()?;
        if chroma_format == 3 {
            separate_colour_plane = reader.bit()? == 1;
        }
        reader.ue()?;
        reader.ue()?;
        reader.skip(1)?;
        if reader.bit()? == 1 {
            for list in 0..if chroma_format == 3 { 12 } else { 8 } {
                if reader.bit()? == 1 {
                    skip_scaling_list(&mut reader, if list < 6 { 16 } else { 64 })?;
                }
            }
        }
    }

    let log2_max_frame_num = reader.ue()? + 4;
    let poc_type = reader.ue()?;
    let mut log2_max_poc_lsb = 0;
    let mut delta_pic_order_always_zero = false;
    match poc_type {
        0 => log2_max_poc_lsb = reader.ue()? + 4,
        1 => {
            delta_pic_order_always_zero = reader.bit()? == 1;
            reader.se()?;
            reader.se()?;
            for _ in 0..reader.ue()? {
                reader.se()?;
            }
        }
        _ => {}
    }
    reader.ue()?;
    reader.skip(1)?;
    reader.ue()?;
    reader.ue()?;
    let frame_mbs_only = reader.bit()? == 1;
    Some((id, Sps { separate_colour_plane, log2_max_frame_num, poc_type, log2_max_poc_lsb, delta_pic_order_always_zero, frame_mbs_only }))
}

fn skip_scaling_list(reader: &mut BitReader, size: u32) -> Option<()> {
    let (mut last, mut next) = (8i64, 8i64);
    for _ in 0..size {
        if next != 0 {
            next = (last + reader.se()? as i64 + 256) % 256;
        }
        last = if next == 0 { last } else { next };
    }
    Some(())
}

fn parse_pps(rbsp: &[u8]) -> Option<(u32, Pps)> {
    let mut reader = BitReader::new(rbsp);
    let id = reader.ue()?;
    let sps_id = reader.ue()?;
    let cabac = reader.bit()? == 1;
    let bottom_field_pic_order = reader.bit()? == 1;
    if reader.ue()? != 0 {
        return None; // Slice groups, which only baseline encoders from long ago use.
    }
    reader.ue()?;
    reader.ue()?;
    reader.skip(3)?;
    reader.se()?;
    reader.se()?;
    reader.se()?;
    let deblocking_control_present = reader.bit()? == 1;
    reader.skip(1)?;
    let redundant_pic_cnt_present = reader.bit()? == 1;
    Some((id, Pps { sps_id, cabac, bottom_field_pic_order, deblocking_control_present, redundant_pic_cnt_present }))
}

struct BitReader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.position / 8)?;
        let bit = (byte >> (7 - self.position % 8)) & 1;
        self.position += 1;
        Some(bit as u32)
    }

    fn bits(&mut self, count: u32) -> Option<u32> {
        let mut value = 0;
        for _ in 0..count {
            value = (value << 1) | self.bit()?;
        }
        Some(value)
    }

    fn skip(&mut self, count: u32) -> Option<()> {
        self.position += count as usize;
        (self.position <= self.data.len() * 8).then_some(())
    }

    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.bits(zeros)?)
    }

    fn se(&mut self) -> Option<i32> {
        let code = self.ue()? as i64;
        Some(if code % 2 == 1 { (code + 1) / 2 } else { -(code / 2) } as i32)
    }
}

#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    used: u32,
}

impl BitWriter {
    fn bit(&mut self, bit: u32) {
        if self.used == 0 {
            self.bytes.push(0);
        }
        if bit != 0 {
            *self.bytes.last_mut().unwrap() |= 1 << (7 - self.used);
        }
        self.used = (self.used + 1) % 8;
    }

    fn ue(&mut self, value: u32) {
        let code = value + 1;
        let length = 32 - code.leading_zeros();
        for _ in 1..length {
            self.bit(0);
        }
        for shift in (0..length).rev() {
            self.bit((code >> shift) & 1);
        }
    }

    fn copy_bits(&mut self, data: &[u8], from: usize, to: usize) {
        for position in from..to {
            self.bit(((data[position / 8] >> (7 - position % 8)) & 1) as u32);
        }
    }

    fn is_aligned(&self) -> bool {
        self.used == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl BitWriter {
        fn bits(&mut self, value: u32, count: u32) {
            for shift in (0..count).rev() {
                self.bit((value >> shift) & 1);
            }
        }

        fn se(&mut self, value: i32) {
            self.ue(if value > 0 { value as u32 * 2 - 1 } else { (-value) as u32 * 2 });
        }

        fn trail(&mut self) {
            self.bit(1);
            while !self.is_aligned() {
                self.bit(0);
            }
        }
    }

    fn sps() -> Vec<u8> {
        let mut w = BitWriter::default();
        w.bits(100, 8); // High profile
        w.bits(0, 8);
        w.bits(51, 8);
        w.ue(0); // id
        w.ue(1); // 4:2:0
        w.ue(0);
        w.ue(0);
        w.bit(0);
        w.bit(0);
        w.ue(4); // log2_max_frame_num = 8
        w.ue(0); // poc type 0
        w.ue(4); // log2_max_poc_lsb = 8
        w.ue(1);
        w.bit(0);
        w.ue(159);
        w.ue(89);
        w.bit(1); // frame_mbs_only
        w.trail();
        let mut nal = vec![0x67];
        escape(&w.bytes, &mut nal);
        nal
    }

    fn pps(cabac: bool) -> Vec<u8> {
        let mut w = BitWriter::default();
        w.ue(0);
        w.ue(0);
        w.bit(cabac as u32);
        w.bit(0);
        w.ue(0);
        w.ue(0);
        w.ue(0);
        w.bits(0, 3);
        w.se(0);
        w.se(0);
        w.se(0);
        w.bit(1); // deblocking control present
        w.bit(0);
        w.bit(0);
        w.trail();
        let mut nal = vec![0x68];
        escape(&w.bytes, &mut nal);
        nal
    }

    /// Writes an IDR header up to the slice data, as an encoder does.
    fn idr_header(w: &mut BitWriter, slice_type: u32) {
        w.ue(0); // first_mb_in_slice
        w.ue(slice_type);
        w.ue(0); // pic_parameter_set_id
        w.bits(0, 8); // frame_num
        w.ue(3); // idr_pic_id
        w.bits(0, 8); // pic_order_cnt_lsb
        w.bits(0, 2); // dec_ref_pic_marking
        w.se(-4); // slice_qp_delta
        w.ue(1); // disable_deblocking_filter_idc
    }

    fn idr(slice_type: u32, cabac: bool, data: &[u8]) -> Vec<u8> {
        let mut w = BitWriter::default();
        idr_header(&mut w, slice_type);
        if cabac {
            while !w.is_aligned() {
                w.bit(1);
            }
            w.bytes.extend_from_slice(data);
        } else {
            for &byte in data {
                w.bits(byte as u32, 8);
            }
            w.trail();
        }
        let mut nal = vec![0x65];
        escape(&w.bytes, &mut nal);
        nal
    }

    fn annex_b(nals: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for nal in nals {
            out.extend_from_slice(&[0, 0, 1]);
            out.extend_from_slice(nal);
        }
        out
    }

    fn prepare(rewriter: &mut Rewriter, input: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        rewriter.prepare(input, &mut out);
        out
    }

    #[test]
    fn makes_every_start_code_four_bytes_and_drops_what_a_decoder_needs_no_network_copy_of() {
        let input = annex_b(&[&[0x09, 0x10], &[0x67, 1], &[0x06, 5], &[0x68, 2], &[0x41, 3, 4], &[0x0c, 0xff]]);
        let output = prepare(&mut Rewriter::new(false), &input);
        assert_eq!(output, [0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x41, 3, 4]);
    }

    #[test]
    fn leaves_trailing_padding_out_of_a_nal_unit() {
        let output = prepare(&mut Rewriter::new(false), &[0, 0, 1, 0x41, 7, 0, 0, 0, 1, 0x41, 8]);
        assert_eq!(output, [0, 0, 0, 1, 0x41, 7, 0, 0, 0, 1, 0x41, 8]);
    }

    fn assert_rewritten(cabac: bool, data: &[u8]) {
        let mut rewriter = Rewriter::new(true);
        let input = annex_b(&[&sps(), &pps(cabac), &idr(7, cabac, data)]);
        let output = prepare(&mut rewriter, &input);
        assert_eq!(rewriter.idr_rewritten, 1);

        let nals: Vec<_> = nal_units(&output).collect();
        let rbsp = unescape(&nals[2][1..]);

        // All of this has to fit in the one clear byte: first_mb, slice_type, and the
        // PPS id's bit: 1, 011, 1.
        assert_eq!(rbsp[0] >> 3, 0b10111);

        let mut reader = BitReader::new(&rbsp);
        assert_eq!(reader.ue(), Some(0));
        assert_eq!(reader.ue(), Some(2));
        assert_eq!(reader.ue(), Some(0));
        assert_eq!(reader.bits(8), Some(0));
        assert_eq!(reader.ue(), Some(3));
        assert_eq!(reader.bits(8), Some(0));
        assert_eq!(reader.bits(2), Some(0));
        assert_eq!(reader.se(), Some(-4));
        assert_eq!(reader.ue(), Some(1));

        if cabac {
            while reader.position % 8 != 0 {
                assert_eq!(reader.bit(), Some(1), "alignment bits are ones");
            }
            assert_eq!(&rbsp[reader.position / 8..], data);
        } else {
            for &byte in data {
                assert_eq!(reader.bits(8), Some(byte as u32));
            }
            assert_eq!(reader.bit(), Some(1), "the stop bit survives");
            while reader.position % 8 != 0 {
                assert_eq!(reader.bit(), Some(0));
            }
            assert_eq!(reader.position, rbsp.len() * 8);
        }
    }

    #[test]
    fn rewrites_a_cabac_idr_keeping_its_data_on_a_byte_boundary() {
        assert_rewritten(true, &[0xde, 0xad, 0xbe, 0xef, 0x80]);
    }

    #[test]
    fn rewrites_a_cavlc_idr_moving_its_data_along_with_the_header() {
        assert_rewritten(false, &[0xde, 0xad, 0xbe, 0xef, 0x55, 0xaa]);
    }

    #[test]
    fn escapes_what_the_rewrite_makes_look_like_a_start_code() {
        assert_rewritten(true, &[0, 0, 1, 0, 0, 0, 3, 0xff, 0x80]);
        assert_rewritten(false, &[0, 0, 1, 0, 0, 0, 3, 0xff, 0x80]);
    }

    #[test]
    fn leaves_an_idr_alone_when_it_already_fits() {
        let mut rewriter = Rewriter::new(true);
        let slice = idr(2, true, &[1, 2, 3, 0x80]);
        let output = prepare(&mut rewriter, &annex_b(&[&sps(), &pps(true), &slice]));
        assert_eq!(rewriter.idr_rewritten, 0);
        assert_eq!(nal_units(&output).nth(2).unwrap(), &slice[..]);
    }

    #[test]
    fn leaves_an_idr_alone_without_its_parameter_sets() {
        let mut rewriter = Rewriter::new(true);
        let slice = idr(7, true, &[1, 2, 3, 0x80]);
        let output = prepare(&mut rewriter, &annex_b(&[&slice]));
        assert_eq!((rewriter.idr_rewritten, rewriter.idr_left_alone), (0, 1));
        assert_eq!(nal_units(&output).next().unwrap(), &slice[..]);
    }

    #[test]
    fn leaves_delta_frames_alone() {
        let mut rewriter = Rewriter::new(true);
        let output = prepare(&mut rewriter, &annex_b(&[&[0x41, 0x9a, 1, 2, 3]]));
        assert_eq!(output, [0, 0, 0, 1, 0x41, 0x9a, 1, 2, 3]);
        assert_eq!(rewriter.idr_rewritten, 0);
    }
}
