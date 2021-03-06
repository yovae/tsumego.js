﻿/// <reference path="utils.ts" />
/// <reference path="stone.ts" />
/// <reference path="rand.ts" />
/// <reference path="prof.ts" />
/// <reference path="sgf.ts" />
/// <reference path="stack.ts" />

module tsumego {
    export var _n_play = 0;
    export var _n_redo = 0;

    /**
     * A block descriptor is represented by a 32 bit signed integer:
     *
     * 0               1               2               3
     *  0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7
     * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     * | xmin  | xmax  | ymin  | ymax  |     libs      |    size     |c|
     * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *
     * The first 2 bytes describe the rectangular boundaries of the block.
     * This implies that blocks must fit in 16x16 board.
     *
     * Next byte contains the number of liberties. Most of the blocks
     * hardly have 20 libs, so 8 bits should be more than enough.
     *
     * The first 7 bits of the last byte contain the number of stones
     * in the block, which gives up to 128 stones. Most of the blocks have
     * less than 15 stones.
     *
     * The last bit is the sign bit of the number and it tells the color
     * of the block: 0 = black, 1 = white. This implies that black blocks
     * are positive and white blocks are negative.
     *
     * Since a block a removed when it loses its last liberty, blocks with
     * libs = 0 or size = 0 do not represent any real entity on the board.
     */
    export enum block { }

    export namespace block {
        export function make(xmin: number, xmax: number, ymin: number, ymax: number, libs: number, size: number, color: number): block {
            return xmin | xmax << 4 | ymin << 8 | ymax << 12 | libs << 16 | size << 24 | color & 0x80000000;
        }

        /** 
         * The board is represented by a square matrix in which
         * each cell contains either block id or 0, if the intersection
         * is unoccupied. This is why block ids start with 1.
         */
        export const enum id {
            min = 1,
            max = 255,
        }

        export const xmin = (b: block) => b & 15;
        export const xmax = (b: block) => b >> 4 & 15;
        export const ymin = (b: block) => b >> 8 & 15;
        export const ymax = (b: block) => b >> 12 & 15;
        export const dims = (b: block) => [xmin(b), xmax(b), ymin(b), ymax(b)];
        export const libs = (b: block) => b >> 16 & 255;
        export const size = (b: block) => b >> 24 & 127;

        /** block.join(0, r) returns r */
        export const join = (b1: block, b2: block) => !b1 ? b2 : block.make(
            min(block.xmin(b1), block.xmin(b2)),
            max(block.xmax(b1), block.xmax(b2)),
            min(block.ymin(b1), block.ymin(b2)),
            max(block.ymax(b1), block.ymax(b2)),
            0, 0, 0);

        /** returns a 1 x 1 block */
        export const just = (s: stone) => {
            const x = stone.x(s);
            const y = stone.y(s);

            return block.make(x, x, y, y, 0, 0, s);
        };

        /** A pseudo block descriptor with 1 liberty. */
        export const lib1 = block.make(0, 0, 0, 0, 1, 0, 0);

        /** Useful when debugging. */
        export const toString = (b: block) => !b ? null : (b > 0 ? '+' : '-') +
            '[' + block.xmin(b) + ', ' + block.xmax(b) + ']x' +
            '[' + block.ymin(b) + ', ' + block.ymax(b) + '] ' +
            'libs=' + block.libs(b) + ' ' + 'size=' + block.size(b);
    }

    /**
     * A square board with size up to 16x16.
     *
     * The board's internal representation supports
     * very fast play(x, y, color) and undo() operations.
     */
    export class Board {
        /** 
         * The max board size is 16x16 because boundaries
         * of each block are stored in 4 bit integers. 
         */
        size: number;

        /**
         * The 32 bit hash of the board. It's efficiently
         * recomputed after each move.
         */
        get hash() {
            return this.hash_b & 0x0000FFFF | this.hash_w & 0xFFFF0000;
        }

        hash_b = 0; // low 32 bits of the 64 bit hash
        hash_w = 0; //  hi 32 bits of the 64 bit hash

        /** 
         * blocks[id] = a block descriptor with this block.id
         *
         * When block #1 is merged with block #2, its size is
         * reset to 0 and its libs is set to #2's id: this trick
         * allows to not modify the board table too often.
         *
         * This means that to get the block libs and other data
         * it's necessary to walk up the chain of merged blocks.
         * This operation is called "lifting" of the block id.
         *
         * When a block is captured, blocks[id] is reset to 0,
         * but the corresponding elements in the board table
         * aren't changed.
         *
         * Elements in this array are never removed. During the
         * lifetime of a block, its descriptor is changed and when
         * the block is captured, its descriptor is nulled, but is
         * never removed from the array.
         */
        blocks: block[] = [0];

        /** 
         * table[y << 4 | x] contains a block id or 0.
         *
         * When a block is merged with another block,
         * this table isn't changed, but the corresponding
         * descriptors of the two blocks get updated in the
         * list of blocks.
         *
         * When a block is captured, correponding cells in
         * this table aren't reset to 0. Instead, the block's
         * descriptor is nulled. This means that even if a table cell
         * contains a non-zero block id, that block may have
         * been deleted long ago. Thus a naive check !table[...]
         * is almost enevr correct: the block id needs to be
         * lifted first before it can be said whether it even
         * exists.
         */
        private table: { [offset: number]: block.id };

        /**
         * Every time a stone is added, changes in the list of blocks
         * and in the board table are stored in the history so that that
         * stone can be quickly undone later. The history rarely exceeds
         * 40 moves, which is considered to be a very deep search when
         * solving a tsumego.
         */
        private history: {
            /** 
             * Every time a stone is added to the board,
             * the following record is added to this list:
             *
             * 0               1               2               3
             *  0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7
             * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
             * |   x   |   y   |    changed    |    block.id   |             |c|
             * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+             
             *
             * The coordinates are stored in the first byte.
             * The number of changed blocks is stored in the 2nd byte.
             * The block id replaced by this move in the table is stored in the 3rd byte.
             * The color of the stone is stored in the sign bit.
             */
            added: Stack<number>;

            /**
             * Before a stone is added, the board's hash is recorded here.
             * It's possible to restore the hash without introducing an extra
             * array in the history, but that solution would be less efficient.
             */
            hashes: Stack<number>;

            /**
             * Every time a block is modified, its id and its previous descriptor
             * from blocks[id] is stored in this list. When a block is removed,
             * its descriptor is nulled.
             */
            changed: Stack<number>;
        };

        private _redo_hist = 0; // tells when the cache is valid
        private _redo_data: {
            // x: 4 bits, y: 4 bits, color: 1 bit (9 bits total)
            [move: number]: {
                hash_b: number; // the board hash is this move is played
                hash_w: number; // the board hash is this move is played
                cell: block.id; // the block id to be set at that move location
                list: number[]; // [block.id, block] pairs that tell what blocks to change
            }
        };

        private _area = sequence(256, () => 0);

        /** 
         * A random 32 bit number for each intersection in the 16x16 board. 
         * The hash of the board is then computed as H(B) = XOR Q(i, j) where
         *
         *      Q(i, j) = hashtb[i, j] if B(i, j) is a B stone
         *      Q(i, j) = hashtw[i, j] if B(i, j) is a W stone
         *
         * This is also known as Zobrist hashing.
         */
        private hasht_b = sequence(256, rand);
        private hasht_w = sequence(256, rand);

        get sgf() {
            return this.toStringSGF();
        }

        set sgf(value: string) {
            this.initFromSGF(value);
        }

        get text() {
            return this.toStringTXT();
        }

        set text(value: string) {
            this.initFromTXT(value.split(/\r?\n/));
        }

        constructor(size: number);
        constructor(size: number, rows: string[]);
        constructor(sgf: string | SGF.Node, /** 1 based */variation?: number);

        constructor(size, setup?) {
            if (typeof size === 'string' || typeof size === 'object')
                this.initFromSGF(size, setup);
            else if (typeof size === 'number') {
                this.init(size);
                if (setup instanceof Array)
                    this.initFromTXT(setup);
            }
        }

        private init(size: number) {
            if (size > 16)
                throw Error(`Board ${size}x${size} is too big. Up to 16x16 boards are supported.`);

            this.size = size;
            this.table = sequence(256, () => 0);
            this.drop();
        }

        private initFromTXT(rows: string[]) {
            rows.map((row, y) => {
                row.replace(/\s/g, '').split('').map((chr, x) => {
                    let c = chr == 'X' ? +1 : chr == 'O' ? -1 : 0;
                    if (c && !this.play(stone.make(x, y, c)))
                        throw new Error('Invalid setup.');
                });
            });

            this.drop();
        }

        private initFromSGF(source: string | SGF.Node, nvar?: number) {
            const sgf = typeof source === 'string' ? SGF.parse(source) : source;
            if (!sgf) throw new SyntaxError('Invalid SGF: ' + source);

            const setup = sgf.steps[0]; // ;FF[4]SZ[19]...
            const size = +setup['SZ'];
            if (!size) throw SyntaxError('SZ[n] tag must specify the size of the board.');

            this.init(size);

            const place = (stones: string[], tag: string) => {
                if (!stones) return;

                for (const xy of stones) {
                    const s = tag + '[' + xy + ']';

                    if (!this.play(stone.fromString(s)))
                        throw new Error(s + ' cannot be added.');
                }
            };

            function placevar(node: SGF.Node) {
                place(node.steps[0]['AW'], 'W');
                place(node.steps[0]['AB'], 'B');
            }

            placevar(sgf);

            if (nvar)
                placevar(sgf.vars[nvar - 1]);

            this.drop();
        }

        /** Drops the history of moves. */
        drop() {
            this.history = {
                added: new Stack<number>(),
                hashes: new Stack<number>(),
                changed: new Stack<number>(),
            };

            for (let i = 0; i < 256; i++)
                this.table[i] = this.lift(this.table[i]);

            this._redo_data = null;
            this._redo_hist = 0;
        }

        /** 
         * Clones the board and without the history of moves.
         * It essentially creates a shallow copy of the board.
         */
        fork(): Board {
            const b = new Board(0);

            b.size = this.size;
            b.hash_b = this.hash_b;
            b.hash_w = this.hash_w;
            b.blocks = this.blocks.slice(0);

            for (let i = 0; i < 256; i++)
                b.table[i] = this.table[i];

            b.drop();
            return b;
        }

        /** Returns a block descriptor. */
        get(x: number, y: number): block;
        /** Returns a block descriptor. */
        get(xy: stone): block;

        get(x: number, y?: number): block {
            if (y === void 0) {
                if (!stone.hascoords(x))
                    return 0;

                [x, y] = stone.coords(x);
            }

            return this.blocks[this.getBlockId(x, y)];
        }

        private lift(id: block.id): block.id {
            let bd: block;

            while (id && !block.size(bd = this.blocks[id]))
                id = block.libs(bd);

            return id;
        }

        /** 
         * Returns block id or zero. 
         * The block data can be read from blocks[id]. 
         */
        private getBlockId(x: number, y: number): block.id {
            if (!this._inBounds(x, y))
                return 0;

            return this.lift(this.table[y << 4 | x]);
        }

        /** 
         * Returns the four neighbors of the stone
         * in the [L, R, T, B] format. 
         */
        private getNbBlockIds(x: number, y: number) {
            return [
                this.getBlockId(x - 1, y),
                this.getBlockId(x + 1, y),
                this.getBlockId(x, y - 1),
                this.getBlockId(x, y + 1)
            ];
        }

        /** 
         * Adjusts libs of the four neighboring blocks
         * of the given color by the given quantity. 
         */
        private adjust(x: number, y: number, color: number, quantity: number) {
            const neighbors = this.getNbBlockIds(x, y);

            next: for (let i = 0; i < 4; i++) {
                const id = neighbors[i];
                const bd = this.blocks[id];

                if (bd * color <= 0)
                    continue;

                for (let j = 0; j < i; j++)
                    if (neighbors[j] == id)
                        continue next;

                this.change(id, bd + quantity * block.lib1);
            }
        }

        /**
         * emoves ablock from the board and adjusts
         * the number of liberties of affected blocks.
         */
        private remove(id: block.id) {
            const bd = this.blocks[id];
            const [xmin, xmax, ymin, ymax] = block.dims(bd);

            for (let y = ymin; y <= ymax; y++) {
                for (let x = xmin; x <= xmax; x++) {
                    if (this.getBlockId(x, y) == id) {
                        if (bd > 0)
                            this.hash_b ^= this.hasht_b[y << 4 | x];
                        else
                            this.hash_w ^= this.hasht_w[y << 4 | x];

                        this.adjust(x, y, -bd, +1);
                    }
                }
            }

            this.change(id, 0);
        }

        /** 
         * Changes the block descriptor and makes
         * an appropriate record in the history. 
         */
        private change(id: block.id, bd: block) {
            // adding a new block corresponds to a change from
            // blocks[blocks.length - 1] -> b
            this.history.changed.push(id);
            this.history.changed.push(id < this.blocks.length ? this.blocks[id] : 0);
            this.blocks[id] = bd;
        }

        inBounds(x: number, y: number): boolean;
        inBounds(xy: stone): boolean;

        inBounds(x: number, y?: number): boolean {
            if (y === void 0) {
                if (!stone.hascoords(x))
                    return false;

                [x, y] = stone.coords(x);
            }

            return this._inBounds(x, y);
        }

        private _inBounds(x: number, y: number) {
            const n = this.size;
            return x >= 0 && x < n && y >= 0 && y < n;
        }

        /** 
         * Returns the number of captured stones + 1.
         * If the move cannot be played, returns 0.
         * The move can be undone by undo().
         *
         * This method only sets table[y * size + x] to
         * to an appropriate block id and changes block
         * descriptors in the array of blocks. It doesn't
         * allocate temporary objects and thus is pretty fast.
         */
        play(move: stone): number {
            if (this._redo_data && this._redo_hist == this.history.added.length) {
                const nres = this.redo(move);

                if (nres)
                    return nres;
            } else {
                this._redo_data = null;
            }

            const color = stone.color(move);

            const x = stone.x(move);
            const y = stone.y(move);

            if (!color || !stone.hascoords(move) || !this._inBounds(x, y) || this.getBlockId(x, y))
                return 0;

            _n_play++;

            const size = this.size;
            const hash_b = this.hash_b;
            const hash_w = this.hash_w;

            const n_changed = this.history.changed.length / 2; // id1, bd1, id2, bd2, ...

            const ids: block.id[] = this.getNbBlockIds(x, y);
            const nbs: block[] = [0, 0, 0, 0];
            const lib = [0, 0, 0, 0];

            for (let i = 0; i < 4; i++) {
                nbs[i] = this.blocks[ids[i]];
                lib[i] = block.libs(nbs[i]);
            }

            // remove captured blocks            

            let result = 0;

            fstr: for (let i = 0; i < 4; i++) {
                for (let j = 0; j < i; j++)
                    // check if that block is already removed
                    if (ids[j] == ids[i])
                        continue fstr;

                if (lib[i] == 1 && color * nbs[i] < 0) {
                    this.remove(ids[i]);
                    result += block.size(nbs[i]);

                    // the removed block may have occupied
                    // several liberties of the stone
                    for (let j = 0; j < 4; j++)
                        if (ids[j] == ids[i])
                            lib[j] = nbs[j] = 0;
                }
            }

            // if nothing has been captured...

            if (result == 0) {
                const isll =
                /* L */ (nbs[0] * color < 0 || lib[0] == 1 || x == 0) &&
                /* R */ (nbs[1] * color < 0 || lib[1] == 1 || x == size - 1) &&
                /* T */ (nbs[2] * color < 0 || lib[2] == 1 || y == 0) &&
                /* B */ (nbs[3] * color < 0 || lib[3] == 1 || y == size - 1);

                // suicide is not allowed
                if (isll)
                    return 0;
            }

            // take away a lib of every neighboring enemy group

            this.adjust(x, y, -color, -1);

            // new group id = min of neighboring group ids

            let id_new: block.id = this.blocks.length;
            let is_new = true;

            for (let i = 0; i < 4; i++) {
                if (nbs[i] * color > 0 && ids[i] < id_new) {
                    id_new = ids[i];
                    is_new = false;
                }
            }

            const id_old = this.table[y << 4 | x];

            this.table[y << 4 | x] = id_new;

            if (color > 0)
                this.hash_b ^= this.hasht_b[y << 4 | x];
            else
                this.hash_w ^= this.hasht_w[y << 4 | x];

            if (is_new) {
                // create a new block if the new stone has no neighbors

                if (id_new > 255)
                    throw Error('Too many blocks: ' + id_new);

                const n =
                    /* L */ (0 == nbs[0] && x > 0 ? 1 : 0) +
                    /* R */ (0 == nbs[1] && x < size - 1 ? 1 : 0) +
                    /* T */ (0 == nbs[2] && y > 0 ? 1 : 0) +
                    /* B */ (0 == nbs[3] && y < size - 1 ? 1 : 0);

                this.change(id_new, block.make(x, x, y, y, n, 1, color));
            } else {
                // merge neighbors into one block

                const fids = [id_new];

                for (let i = 0; i < 4; i++)
                    if (nbs[i] * color > 0 && ids[i] != id_new)
                        fids.push(ids[i]);

                let size_new = 1;

                let xmin_new = x;
                let xmax_new = x;
                let ymin_new = y;
                let ymax_new = y;

                for (let i = 0; i < fids.length; i++) {
                    const id = fids[i];
                    const bd = this.blocks[id];

                    size_new += block.size(bd);

                    const xmin = block.xmin(bd);
                    const xmax = block.xmax(bd);
                    const ymin = block.ymin(bd);
                    const ymax = block.ymax(bd);

                    xmin_new = min(xmin_new, xmin);
                    ymin_new = min(ymin_new, ymin);
                    xmax_new = max(xmax_new, xmax);
                    ymax_new = max(ymax_new, ymax);

                    // make the merged block point to the new block

                    if (id != id_new)
                        this.change(id, block.make(0, 0, 0, 0, id_new, 0, 0));
                }

                // libs need to be counted in the rectangle extended by 1 intersection

                let libs_new = 0;

                const xmin_1 = max(xmin_new - 1, 0);
                const ymin_1 = max(ymin_new - 1, 0);

                const xmax_1 = min(xmax_new + 1, size - 1);
                const ymax_1 = min(ymax_new + 1, size - 1);

                const area = this._area;

                for (let y = ymin_1; y <= ymax_1; y++)
                    for (let x = xmin_1; x <= xmax_1; x++)
                        area[x | y << 4] = this.lift(this.table[x | y << 4]);

                for (let y = ymin_1; y <= ymax_1; y++) {
                    for (let x = xmin_1; x <= xmax_1; x++) {
                        if (area[x | y << 4])
                            continue;

                        const is_lib =
                            x > xmin_1 && area[x - 1 | y << 4] == id_new ||
                            y > ymin_1 && area[x | y - 1 << 4] == id_new ||
                            x < xmax_1 && area[x + 1 | y << 4] == id_new ||
                            y < ymax_1 && area[x | y + 1 << 4] == id_new;

                        if (is_lib)
                            libs_new++;
                    }
                }

                this.change(id_new, block.make(xmin_new, xmax_new, ymin_new, ymax_new, libs_new, size_new, color));
            }

            this.history.added.push(x | y << 4
                | this.history.changed.length / 2 - n_changed << 8
                | id_old << 16
                | color & 0x80000000);

            this.history.hashes.push(hash_b);
            this.history.hashes.push(hash_w);

            return result + 1;
        }

        /** 
         * Reverts the last move by restoring the original
         * block id in table[y * size + x] and by reverting
         * original values of block descriptors.
         *
         * Returns the restored move or zero. The returned
         * move can be given to .play to redo the position.
         */
        undo(): stone {
            const move = this.history.added.pop();

            if (!move)
                return 0;

            const x = move & 15;
            const y = move >> 4 & 15;
            const k = y << 4 | x;
            const c = move & 0x80000000 ? -1 : +1;
            const n = move >> 8 & 255;
            const b = move >> 16 & 255;

            const next = {
                hash_b: this.hash_b,
                hash_w: this.hash_w,
                cell: this.table[k],
                list: [],
            };

            this.table[k] = b;

            this.hash_w = this.history.hashes.pop();
            this.hash_b = this.history.hashes.pop();

            for (let i = 0; i < n; i++) {
                const bd = this.history.changed.pop();
                const id = this.history.changed.pop();

                next.list.push(id, this.blocks[id]);

                // when a new block is added, the corresponding
                // record in the history looks like changing
                // the last block from 0 to something;; to undo
                // this properly, the last element in the array
                // needs to be removed as well
                if (id == this.blocks.length - 1 && !bd)
                    this.blocks.pop();
                else
                    this.blocks[id] = bd;
            }

            const rh = this.history.added.length;

            if (!this._redo_data || this._redo_hist != rh) {
                this._redo_data = [];
                this._redo_hist = rh;
            }

            this._redo_data[x | y << 4 | c & 256] = next;

            return stone.make(x, y, c);
        }

        /**
         * Quickly replays a move if it has been played and undone.
         * About 47% of calls to play(...) are handled here, however
         * this makes the solver only 1.18x faster, perhaps due to
         * the need to support the redo cache. The redo(...) itself
         * spends only 9% of the time, while play(...) spends 44%.
         */
        private redo(move: stone): number {
            const [x, y] = stone.coords(move);
            const k = y << 4 | x;
            const c = move > 0 ? +1 : -1;
            const next = this._redo_data[x | y << 4 | c & 256];

            if (!next)
                return 0;

            _n_redo++;

            this.history.hashes.push(this.hash_b);
            this.history.hashes.push(this.hash_w);

            this.history.added.push(x | y << 4
                | next.list.length / 2 << 8
                | this.table[k] << 16
                | c & 0x80000000);

            this.hash_b = next.hash_b;
            this.hash_w = next.hash_w;

            this.table[k] = next.cell;

            let nres = 0;

            for (let i = next.list.length - 2; i >= 0; i -= 2) {
                const id = next.list[i];
                const bd = next.list[i + 1];

                if (!bd)
                    nres += block.size(this.blocks[id]);

                this.history.changed.push(id);
                this.history.changed.push(this.blocks[id]);
                this.blocks[id] = bd;
            }

            return nres + 1;
        }

        rect(color: number) {
            let rect: block = 0;

            for (let i = 0; i < this.blocks.length; i++) {
                const b = this.blocks[i];

                if (!block.size(b))
                    continue;

                if (b * color >= 0)
                    rect = block.join(rect, b);
            }

            return rect;
        }

        getRemovedBlocks() {
            const moves = this.history.added;
            const blocks = this.history.changed;

            const move = moves[moves.length - 1];
            const n = move >> 8 & 255;

            const removed: block[] = [];

            for (let i = 0; i < n; i++) {
                const id = blocks[blocks.length - i * 2]
                const bd = blocks[blocks.length - i * 2 + 1];

                if (bd && !this.blocks[id])
                    removed.push(bd);
            }

            return removed;
        }

        range(color = 0) {
            const stones: stone[] = [];

            for (let y = 0; y < this.size; y++)
                for (let x = 0; x < this.size; x++)
                    stones.push(stone.make(x, y, color));

            return stones;
        }

        toStringSGF(indent = '') {
            const take = (pf: string, fn: (g: number) => boolean) => {
                let list = '';

                for (let y = 0; y < this.size; y++)
                    for (let x = 0; x < this.size; x++)
                        if (fn(this.get(x, y)))
                            list += stone.toString(stone.make(x, y, +1)).slice(1);

                return list && indent + pf + list;
            }

            return '(;FF[4]SZ[' + this.size + ']'
                + take('AB', c => c > 0)
                + take('AW', c => c < 0) + ')';
        }

        toStringTXT(mode = '') {
            const hideLabels = /L-/.test(mode);
            const showLibsNum = /R/.test(mode);

            let xmax = 0, ymax = 0, s = '';

            for (let x = 0; x < this.size; x++)
                for (let y = 0; y < this.size; y++)
                    if (this.get(x, y))
                        xmax = max(x, xmax),
                            ymax = max(y, ymax);

            if (!hideLabels) {
                s += ' ';

                for (let x = 0; x <= xmax; x++)
                    s += ' ' + stone.toString(stone.make(x, 0, 0))[1];
            }

            for (let y = 0; y <= ymax; y++) {
                if (s)
                    s += '\n';

                if (!hideLabels)
                    s += stone.toString(stone.make(0, y, 0))[2];

                for (let x = 0; x <= xmax; x++) {
                    const b = this.get(x, y);

                    s += ' ';

                    s += showLibsNum ? block.libs(b) :
                        b > 0 ? 'X' :
                            b < 0 ? 'O' :
                                '-';
                }
            }

            return s;
        }

        toString(mode?: string): string {
            return mode == 'SGF' ?
                this.toStringSGF() :
                this.toStringTXT(mode);
        }

        /**
         * stones() lists all the stones on the board
         * stones(b) lists only stones that belong to block b
         * stones(0) returns an ampty list
         * stones(+1) returns all black stones
         * stones(-1) returns all white stones
         */
        *stones(t?: block | color) {
            const all = t === undefined;

            if (!all && !t) return;

            const [xmin, xmax, ymin, ymax] = all || t == color.black || t == color.white ?
                [0, this.size - 1, 0, this.size - 1] :
                block.dims(<block>t);

            for (let x = xmin; x <= xmax; x++) {
                for (let y = ymin; y <= ymax; y++) {
                    const b = this.get(x, y);

                    if (all ? b != 0 : t == +1 ? b > 0 : t == -1 ? b < 0 : b == t)
                        yield stone.make(x, y, b);
                }
            }
        }

        /** Checks if (x, y) is a liberty of block b. */
        isLibertyOf(x: number, y: number, b: block) {
            return this.get(x - 1, y) == b || this.get(x + 1, y) == b || this.get(x, y - 1) == b || this.get(x, y + 1) == b;
        }

        /**
         * for (const [x, y] of board.libs(block))
         *      console.log("a liberty of the block", x, y);
         */
        *libs(b: block) {
            for (const [x, y] of this.edge(b))
                if (!this.get(x, y))
                    yield [x, y];
        }

        /** All cells adjacent to the block: empty and occupied by the opponent. */
        *edge(b: block) {
            if (!b) return;

            let [xmin, xmax, ymin, ymax] = block.dims(b);

            if (xmin > 0) xmin--;
            if (ymin > 0) ymin--;

            if (xmax < this.size - 1) xmax++;
            if (ymax < this.size - 1) ymax++;

            for (let x = xmin; x <= xmax; x++) {
                for (let y = ymin; y <= ymax; y++) {
                    if (this.get(x, y) * b > 0)
                        continue;

                    const isLib =
                        this.inBounds(x - 1, y) && this.get(x - 1, y) == b ||
                        this.inBounds(x, y - 1) && this.get(x, y - 1) == b ||
                        this.inBounds(x + 1, y) && this.get(x + 1, y) == b ||
                        this.inBounds(x, y + 1) && this.get(x, y + 1) == b;

                    if (isLib)
                        yield [x, y];
                }
            }
        }

        neighbors(x: number, y: number): [number, number][] {
            const nbs = [];

            if (this.inBounds(x - 1, y))
                nbs.push([x - 1, y]);

            if (this.inBounds(x + 1, y))
                nbs.push([x + 1, y]);

            if (this.inBounds(x, y - 1))
                nbs.push([x, y - 1]);

            if (this.inBounds(x, y + 1))
                nbs.push([x, y + 1]);

            return nbs;
        }

        nblocks(color: number) {
            let n = 0;

            for (let i = 0; i < this.blocks.length; i++) {
                const b = this.blocks[i];

                if (b * color > 0 && block.size(b) > 0)
                    n++;
            }

            return n;
        }

        nstones(color: number) {
            let n = 0;

            for (let i = 0; i < this.blocks.length; i++) {
                const b = this.blocks[i];

                if (b * color > 0)
                    n += block.size(b);
            }

            return n;
        }

        sumlibs(color: number) {
            let n = 0;

            for (let i = 0; i < this.blocks.length; i++) {
                const b = this.blocks[i];

                if (b * color > 0 && block.size(b) > 0)
                    n += block.libs(b);
            }

            return n;
        }

        natari(color: number) {
            let n = 0;

            for (let i = 0; i < this.blocks.length; i++) {
                const b = this.blocks[i];

                if (b * color > 0 && block.size(b) > 0 && block.libs(b) == 1)
                    n++;
            }

            return n;
        }

        /** the sequence of moves that was given to .play(...) to get this position */
        get moves() {
            const moves: stone[] = [];

            for (const x of this.history.added)
                moves.push(stone.make(x & 15, x >> 4 & 15, x));

            return moves;
        }
    }
}
