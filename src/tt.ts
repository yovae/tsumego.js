module tsumego {
    /**
     * 0               1               2               3
     *  0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7
     * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     * |   x   |   y   |  b  |  w  |u|m|        same for white         |
     * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *
     * The first 2 bytes tell the outcome if black can play first:
     *
     *      b - if km >= b, then black wins; b = -3..+3
     *      w - if km <= w, then white wins; w = -3..+3
     *      m - if km >= b, m tells if black needs to play at (x, y) to win
     *      u - this bit isn't used at the moment
     *
     * where km = +1 means that W is the ko master, km = -1 means
     * that B is the ko master and km = 0 means neither B nor W has
     * external ko treats.
     *
     * The next 2 bytes tell the outcome if white can play first.
     *
     * Obviously, w < b, as otherwise the status would be ambiguous.
     * This implies that the zero entry is not valid.
     */
    type entry = number;

    function entry(x: number, y: number, b: number, w: number, m: boolean) {
        return x | y << 4 | (b & 7) << 8 | (w & 7) << 11 | (m ? 0x8000 : 0);
    }

    module entry {
        export const get = (s: entry, color: number) => (color > 0 ? s : s >> 16) & 0xFFFF;
        export const set = (s: entry, color: number, e: entry) => color > 0 ? s & ~0xFFFF | e : s & 0xFFFF | e << 16;

        export const x = (e: entry) => e & 15;
        export const y = (e: entry) => e >> 4 & 15;
        export const b = (e: entry) => (e >> 8 & 7) << 29 >> 29;
        export const w = (e: entry) => (e >> 11 & 7) << 29 >> 29;
        export const m = (e: entry) => !!(e & 0x8000);
    }

    module entry {
        const e = entry(0, 0, +3, -3, false);
        export const base = e | e << 16;
    }

    /** Transposition Table */
    export class TT {
        size = 0;

        move: { [node: number]: stone } = {};

        private data: { [hash: number]: entry } = {};

        get(hash: number, color: number, km: number) {
            const s = this.data[hash];

            if (!s) return 0;

            const e = entry.get(s, color);

            const winner =
                km >= entry.b(e) ? +1 : // enough ko treats for black
                    km <= entry.w(s) ? -1 : // enough ko treats for white
                        0; // not solved for this number of ko treats

            if (!winner) return 0;

            // the move must be dropped if the outcome is a loss
            return winner * color > 0 && entry.m(e) ?
                stone(entry.x(e), entry.y(e), winner) :
                stone.nocoords(winner);
        }

        /** 
         * @param color Who plays first.
         * @param move The outcome. Must have a color and may have coordinates.
         * @param km Must be either-1, +1 or 0.
         */
        set(hash: number, color: number, move: stone, km: number) {
            if (km != -1 && km != +1 && km != 0 || !stone.color(move))
                throw Error('Invalid TT entry.');

            const s = this.data[hash] || ++this.size && entry.base;
            const e = entry.get(s, color);

            // The idea here is to not override the winning move.
            // A typical case is the bent 4 shape: B wins if there are
            // no ko treats and loses if W has ko treats. If the first
            // solution is written first, then the second solution shouldn't
            // override the winning move.
            const [x, y, hc] = move * color > 0 ?
                [stone.x(move), stone.y(move), stone.hascoords(move)] :
                [entry.x(e), entry.y(e), entry.m(e)];

            const b = entry.b(e);
            const w = entry.w(e);

            const e2 = move > 0 && km < b ? entry(x, y, km, w, hc) :
                move < 0 && km > w ? entry(x, y, b, km, hc) :
                    e;            

            this.data[hash] = entry.set(s, color, e2);
        }
    }
}
