//! The XMLTV feed as a stream (`livetv-guide.md` rules 12, 13, 26): the network body feeds a blocking
//! reader through a bounded channel, the reader's elements come back through another, so memory stays
//! bounded whatever the file size.
use bytes::Bytes;
use flate2::read::MultiGzDecoder;
use fliks_domain::livetv::xmltv::{self, Channel, Options, Programme, Sink};
use std::{
    collections::HashSet,
    io::{self, Read},
    sync::Arc,
};
use tokio::sync::{mpsc, oneshot};

/// Inflated bytes beyond this are refused (F72).
const MAX_INFLATED: u64 = 1024 * 1024 * 1024;

/// What the reader hands the async side.
pub enum Item {
    Channel(Channel),
    /// The channel list is complete; the answer is the set of guide ids whose programmes are wanted.
    ChannelsDone {
        programmes_follow: bool,
        wanted: oneshot::Sender<Arc<HashSet<String>>>,
    },
    Programme(Box<Programme>),
}

/// The body chunks as a blocking `Read`.
struct ChunkReader {
    rx: mpsc::Receiver<io::Result<Bytes>>,
    cur: Bytes,
}

impl Read for ChunkReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if !self.cur.is_empty() {
                let n = self.cur.len().min(buf.len());
                buf[..n].copy_from_slice(&self.cur.split_to(n));
                return Ok(n);
            }
            match self.rx.blocking_recv() {
                Some(Ok(chunk)) => self.cur = chunk,
                Some(Err(e)) => return Err(e),
                None => return Ok(0),
            }
        }
    }
}

/// Refuses to hand over more than `left` bytes.
struct Capped<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let want = buf
            .len()
            .min(usize::try_from(self.left.saturating_add(1)).unwrap_or(usize::MAX));
        let n = self.inner.read(&mut buf[..want])?;
        if n as u64 > self.left {
            return Err(io::Error::other("decompressed feed too large"));
        }
        self.left -= n as u64;
        Ok(n)
    }
}

/// The first two bytes decide: `1f 8b` is gunzipped (members concatenated), anything else read as is.
pub fn open_feed<R: Read + 'static>(mut r: R) -> io::Result<Box<dyn Read>> {
    let mut head = [0u8; 2];
    let mut n = 0;
    while n < 2 {
        let got = r.read(&mut head[n..])?;
        if got == 0 {
            break;
        }
        n += got;
    }
    let chained = io::Cursor::new(head[..n].to_vec()).chain(r);
    Ok(if head == [0x1f, 0x8b] {
        Box::new(Capped {
            inner: MultiGzDecoder::new(chained),
            left: MAX_INFLATED,
        })
    } else {
        Box::new(chained)
    })
}

struct ChanSink {
    tx: mpsc::Sender<Item>,
    wanted: Arc<HashSet<String>>,
    gone: bool,
}

impl Sink for ChanSink {
    fn channel(&mut self, c: Channel) {
        self.gone |= self.tx.blocking_send(Item::Channel(c)).is_err();
    }

    fn channels_done(&mut self, programmes_follow: bool) {
        let (wanted, answer) = oneshot::channel();
        if self
            .tx
            .blocking_send(Item::ChannelsDone {
                programmes_follow,
                wanted,
            })
            .is_err()
        {
            self.gone = true;
            return;
        }
        match answer.blocking_recv() {
            Ok(w) => self.wanted = w,
            Err(_) => self.gone = true,
        }
    }

    fn stop(&self) -> bool {
        self.gone
    }

    fn wants(&self, channel_id: &str) -> bool {
        self.wanted.contains(channel_id)
    }

    fn programme(&mut self, p: Programme) {
        self.gone |= self.tx.blocking_send(Item::Programme(Box::new(p))).is_err();
    }
}

/// Starts the reader on a blocking thread over `body`'s chunks; the returned receiver yields its items,
/// the handle its end (an I/O error of the body or the inflater is the error).
pub fn start(
    mut body: reqwest::Response,
    opts: Options,
    max_body: usize,
    on_error: impl Fn(&reqwest::Error) -> String + Send + 'static,
) -> (
    mpsc::Receiver<Item>,
    tokio::task::JoinHandle<io::Result<xmltv::Stats>>,
) {
    let (chunks_tx, chunks_rx) = mpsc::channel::<io::Result<Bytes>>(4);
    tokio::spawn(async move {
        let mut total = 0usize;
        loop {
            let next = match body.chunk().await {
                Ok(Some(c)) => Ok(c),
                Ok(None) => return,
                Err(e) => Err(io::Error::other(on_error(&e))),
            };
            let fail = match &next {
                Ok(c) => {
                    total += c.len();
                    (total > max_body)
                        .then(|| io::Error::other("maxContentLength size of 536870912 exceeded"))
                }
                Err(_) => None,
            };
            let msg = fail.map_or(next, Err);
            let stop = msg.is_err();
            if chunks_tx.send(msg).await.is_err() || stop {
                return;
            }
        }
    });
    let (items_tx, items_rx) = mpsc::channel::<Item>(256);
    let reader = tokio::task::spawn_blocking(move || {
        let input = open_feed(ChunkReader {
            rx: chunks_rx,
            cur: Bytes::new(),
        })?;
        let mut sink = ChanSink {
            tx: items_tx,
            wanted: Arc::default(),
            gone: false,
        };
        xmltv::parse_stream(input, &opts, &mut sink)
    });
    (items_rx, reader)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    fn gz(data: &[u8]) -> Vec<u8> {
        let mut e = GzEncoder::new(vec![], Compression::fast());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn read_all(bytes: Vec<u8>) -> Vec<u8> {
        let mut out = vec![];
        open_feed(io::Cursor::new(bytes))
            .unwrap()
            .read_to_end(&mut out)
            .unwrap();
        out
    }

    #[test]
    fn a_gzip_body_is_inflated_a_plain_one_and_an_empty_one_are_not() {
        assert_eq!(read_all(gz(b"<tv/>")), b"<tv/>");
        let mut two = gz(b"<tv>");
        two.extend(gz(b"</tv>"));
        assert_eq!(read_all(two), b"<tv></tv>");
        assert_eq!(read_all(b"<tv/>".to_vec()), b"<tv/>");
        assert_eq!(read_all(vec![]), b"");
        assert_eq!(read_all(vec![0x1f]), vec![0x1f]);
    }

    #[test]
    fn inflation_stops_at_the_cap() {
        let mut c = Capped {
            inner: io::Cursor::new(vec![7u8; 100]),
            left: 64,
        };
        let mut out = vec![];
        let e = c.read_to_end(&mut out).unwrap_err();
        assert!(e.to_string().contains("too large"));
    }

    #[test]
    fn a_truncated_gzip_stream_is_an_error() {
        let mut bytes = gz(&vec![b'x'; 10_000]);
        bytes.truncate(bytes.len() / 2);
        let mut out = vec![];
        assert!(
            open_feed(io::Cursor::new(bytes))
                .unwrap()
                .read_to_end(&mut out)
                .is_err()
        );
    }
}
