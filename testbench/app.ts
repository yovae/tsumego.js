/// <reference path="kb.ts" />
/// <reference path="xhr.ts" />
/// <reference path="ls.ts" />
/// <reference path="../src/solver.ts" />
/// <reference path="goban.ts" />

declare var board: tsumego.Board;

window['board'] = null;

module testbench {
    import stone = tsumego.stone;
    import Board = tsumego.Board;
    import profile = tsumego.profile;

    /** In SGF a B stone at x = 8, y = 2
        is written as B[ic] on a 9x9 goban
        it corresponds to J7 - the I letter
        is skipped and the y coordinate is
        counted from the bottom starting from 1. */
    const xy2s = (m: stone) => !stone.hascoords(m) ? null :
        String.fromCharCode(0x41 + (stone.x(m) > 7 ? stone.x(m) - 1 : stone.x(m))) +
        (board.size - stone.y(m));

    const c2s = (c: number) => c > 0 ? 'B' : 'W';
    const s2c = (s: string) => s == 'B' ? +1 : s == 'W' ? -1 : 0;
    const cm2s = (c: number, m: stone) => c2s(c) + (Number.isFinite(m) ? ' plays at ' + xy2s(m) : ' passes');
    const cw2s = (c: number, m: stone) => c2s(c) + ' wins by ' + (Number.isFinite(m) ? xy2s(m) : 'passing');

    function s2s(c: number, s: stone) {
        let isDraw = stone.color(s) == 0;
        let isLoss = s * c < 0;

        return c2s(c) + ' ' + (isLoss ? 'loses' : (isDraw ? 'draws' : 'wins') + ' with ' + xy2s(s));
    }

    /** shared transposition table for black and white */
    export var tt = new tsumego.TT;

    function solve(board: Board, color: number, nkotreats: number = 0, log = false) {
        profile.reset();

        const rs = tsumego.solve({
            root: board,
            color: color,
            nkt: nkotreats,
            tt: tt,
            expand: tsumego.generators.Basic(rzone),
            status: status
        });

        if (log) {
            profile.log();
            console.log(s2s(color, rs));
        }

        return rs;
    }

    class CancellationToken {
        cancelled = false;
    }

    function sleep(ms: number) {
        return new Promise<void>(resolve => setTimeout(resolve, ms));
    }

    function dbgsolve(board: Board, color: number, nkotreats = 0) {
        const solver = tsumego.solve.start({
            debug: true,
            root: board,
            color: color,
            nkt: nkotreats,
            tt: tt,
            expand: tsumego.generators.Basic(rzone),
            status: status,
            alive: (b: Board) => tsumego.benson.alive(b, aim)
        });

        window['solver'] = solver;

        let tick = 0;

        const next = (render = true) => {
            const {done, value} = solver.next();
            const comment: string = value;
            !done && tick++;

            if (render) {
                location.hash = '#hash=' + (0x100000000 + board.hash).toString(16).slice(-8) + '&step=' + tick;
                lspath = null;
                renderBoard(comment);
            }
        };

        const stepOver = (ct: CancellationToken) => {
            const hash = board.hash;

            do {
                next(false);
            } while (board.hash != hash && !ct.cancelled);

            next();
        };

        const stepOut = () => {
            /*
            log = false;
            const n = solver.depth;
            while (solver.depth >= n)
                next();
            log = true;
            renderSGF(solver.current.node.toString('SGF'));
            */
        };

        keyboard.hook(keyboard.Key.F10, event => {
            event.preventDefault();
            const ct = new CancellationToken;
            const hook = keyboard.hook(keyboard.Key.Esc, event => {
                event.preventDefault();
                console.log('cancelling...');
                ct.cancelled = true;
            });

            stepOver(ct);
        });

        keyboard.hook(keyboard.Key.F11, event => {
            if (!event.shiftKey) {
                event.preventDefault();
                if (event.ctrlKey)
                    debugger;
                next();
            } else {
                // Shift+F11
                event.preventDefault();
                stepOut();
            }
        });

        console.log(c2s(color), 'to play with', nkotreats, 'external ko treats\n',
            'F11 - step into\n',
            'Ctrl+F11 - step into and debug\n',
            'F10 - step over\n',
            'Shift+F11 - step out\n',
            'G - go to a certain step\n');

        keyboard.hook('G'.charCodeAt(0), event => {
            event.preventDefault();
            const stopat = +prompt('Step #:');
            if (!stopat) return;
            console.log('skipping first', stopat, 'steps...');
            while (tick < stopat)
                next();
            renderBoard();
        });
    }

    function status(b: Board) {
        return b.get(stone.x(aim), stone.y(aim)) < 0 ? -1 : +1;
    }

    var rzone: stone[] = [], aim = 0, lspath = '';

    window.addEventListener('load', () => {
        Promise.resolve().then(() => {
            if (!location.search) {
                document.querySelector('.solver').remove();

                function addSection(name = 'Unnamed') {
                    const header = document.createElement('h3');
                    const section = document.createElement('div');

                    header.textContent = name;

                    document.body.appendChild(header);
                    document.body.appendChild(section);

                    return section;
                }

                function addPreview(section: HTMLElement, board: Board, href: string) {
                    const preview = document.createElement('a');

                    preview.className = 'tsumego-preview';
                    preview.href = href;
                    preview.appendChild(gobanui.render(board));
                    section.appendChild(preview);

                    return preview;
                }

                const locals = addSection('Problems from localStorage');
                const newProblem = addPreview(locals, new Board(9), '?:' + Math.random().toString(16).slice(2) + ':9');
                newProblem.title = 'Create a new problem.';

                const lsdata = ls.data;

                for (let path in lsdata)
                    addPreview(locals, new Board(lsdata[path]), '?' + path);

                return send('GET', '/problems/manifest.json').then(data => {
                    const manifest = JSON.parse(data);

                    for (const dir of manifest.dirs) {
                        const section = addSection(dir.description);

                        for (const path of dir.problems) {
                            send('GET', '/problems/' + path).then(sgf => {
                                const root = tsumego.SGF.parse(sgf);

                                if (!root)
                                    throw SyntaxError('Invalid SGF from ' + path);

                                for (let nvar = 0; nvar <= root.vars.length; nvar++)
                                    addPreview(section, new Board(root, nvar), '?' + path.replace('.sgf', '') + ':' + nvar);
                            }).catch(err => {
                                console.log(err.stack);
                            });
                        }
                    }
                });
            } else {
                const [, source, bw, nkt, nvar] = /^\?([:]?[^:]+)(?::(B|W)([+-]\d+))?(?::(\d+))?/.exec(location.search);

                document.title = source;

                if (source[0] == ':')
                    lspath = source;

                let lastsi = 'B+0';

                document.querySelector('#solve').addEventListener('click', e => {
                    const input = prompt('Color and the number of ext ko treats (-2..+2), e.g. W-2, B+1, W, B:', lastsi);
                    if (!input) return;

                    lastsi = input;
                    const parsed = /^(B|W)([+-][012])?$/.exec(input);

                    if (!parsed) {
                        setComment('Invalid input: ' + input);
                        return;
                    }

                    const [, color, nkt] = parsed;
                    solveAndRender(s2c(color), nkt ? +nkt : 0);
                });

                document.querySelector('#reset').addEventListener('click', e => {
                    aim = 0;
                    rzone = [];
                    board = new Board(board.size);
                    renderBoard();
                });

                const sgfinput = <HTMLTextAreaElement>document.querySelector('#sgf');

                sgfinput.addEventListener('input', e => {
                    try {
                        updateSGF(sgfinput.value);
                    } catch (err) {
                        // partial input is not valid SGF
                        if (err instanceof SyntaxError)
                            return;
                        throw err;
                    }
                });

                document.querySelector('#debug').addEventListener('click', e=> {
                    dbgsolve(board, bw == 'W' ? -1 : +1, +nkt);
                });

                if (source[0] == ':' && !ls.data[source]) {
                    board = new Board(+nvar);
                    renderBoard('Add stones, mark possible moves and select target.');
                } else {
                    return Promise.resolve().then(() => {
                        return source[0] == '(' ? source :
                            source[0] == ':' ? ls.data[source] :
                                send('GET', '/problems/' + source + '.sgf');
                    }).then(sgfdata => {
                        updateSGF(sgfdata, source[0] != ':' && nvar && +nvar);

                        console.log(sgfdata);
                        console.log(board + '');
                        console.log(board.toStringSGF());
                    });
                }
            }
        }).catch(err => {
            console.error(err.stack);
            alert(err);
        });
    });

    function updateSGF(sgfdata: string, nvar = 0) {
        const sgf = tsumego.SGF.parse(sgfdata);
        const setup = sgf.steps[0];

        board = new Board(sgfdata, nvar);
        aim = stone.fromString((setup['MA'] || ['aa'])[0]);
        rzone = (setup['SL'] || []).map(stone.fromString);

        board = board.fork(); // drop the history of moves
        renderBoard();
    }

    function renderBoard(comment = '') {
        const move = board.undo();
        board.play(move);

        const ui = gobanui.render(board, {
            TR: stone.hascoords(move) && [move],
            MA: stone.hascoords(aim) && [aim],
            SL: !stone.hascoords(move) && rzone
        });

        ui.addEventListener('click', event => {
            const rb = <HTMLInputElement>document.querySelector('input[name="tool"]:checked');

            if (!lspath || !rb) return;

            event.preventDefault();
            event.stopPropagation();

            const [x, y] = ui.getStoneCoords(event.offsetX, event.offsetY);
            const c = board.get(x, y);

            switch (rb.value) {
                case 'MA':
                    // mark the target                    
                    aim = c < 0 ? stone(x, y, 0) : 0;
                    break;

                case 'SQ':
                    // extend the r-zone
                    const s = stone(x, y, 0);
                    const i = rzone.indexOf(s);

                    if (i < 0)
                        rzone.push(s);
                    else
                        rzone.splice(i, 1);

                    break;

                case 'AB':
                    // add a black stone
                    if (c) return;
                    board.play(stone(x, y, +1));
                    board = board.fork(); // drop history
                    break;

                case 'AW':
                    // add a white stone
                    if (c) return;
                    board.play(stone(x, y, -1));
                    board = board.fork(); // drop history
                    break;

                case '--':
                    // remove a stone
                    const b = new Board(board.size);

                    for (const s of board.stones()) {
                        const [sx, sy] = stone.coords(s);
                        const c = stone.color(s);

                        if (sx != x || sy != y)
                            b.play(stone(sx, sy, c));
                    }

                    board = b.fork(); // drop history
                    break;
            }

            renderBoard();
        });

        const wrapper = document.querySelector('.tsumego') as HTMLElement;
        wrapper.innerHTML = '';
        wrapper.appendChild(ui);

        const editor = document.querySelector('.tsumego-sgf') as HTMLElement;

        const sgf = board.toStringSGF('\n  ').replace(/\)$/,
            (rzone.length > 0 ? '\n  SL[' + rzone.map(stone.toString).join('][') + ']' : '') +
            (stone.hascoords(aim) ? '\n  MA[' + stone.toString(aim) + ']' : '') +
            ')');

        editor.textContent = sgf;

        setComment(comment);

        if (lspath)
            ls.set(lspath, sgf);
    }

    function setComment(comment: string) {
        document.querySelector('#comment').textContent = comment;
    }

    function parse(si: string, size: number): stone {
        const x = si.charCodeAt(0) - 65;
        const y = size - +/\d+/.exec(si)[0];

        return stone(x, y, 0);
    }

    function solveAndRender(color: number, nkt = 0) {
        setComment('Solving... Unfortunately, there is no way to terminate the solver.');

        setTimeout(() => {
            const move = solve(board, color, nkt, true);

            if (!stone.hascoords(move) || move * color < 0) {
                setComment(c2s(color) + ' passes');
            } else {
                board.play(move);
                console.log(board + '');
                renderBoard();
            }
        });
    }

    window['$'] = data => {
        const cmd = data.toString().trim().split(' ');
        const col = cmd[0].toLowerCase();

        switch (col) {
            case 'x':
            case 'o':
                const xy = cmd[1] && cmd[1].toUpperCase();
                const c = cmd[0].toUpperCase() == 'O' ? -1 : +1;

                if (/^[a-z]\d+$/i.test(xy)) {
                    const p = parse(xy, board.size);

                    if (!board.play(stone(stone.x(p), stone.y(p), c))) {
                        console.log(col, 'cannot play at', xy);
                    } else {
                        console.log(board + '');
                        renderBoard();
                    }
                } else {
                    solveAndRender(c, !xy ? 0 : +xy);
                }
                break;

            case 'undo':
                let n = +(cmd[1] || 1);

                while (n-- > 0) {
                    const move = board.undo();

                    if (move) {
                        console.log('undo ' + stone.toString(move));
                    } else {
                        console.log('nothing to undo');
                        break;
                    }
                }

                console.log(board + '');
                break;

            case 'path':
                let move: stone, moves: stone[] = [];

                while (move = board.undo())
                    moves.unshift(move);

                for (move of moves) {
                    console.log(board + '');
                    board.play(move);
                }

                console.log(board + '');
                break;

            default:
                console.log('unknown command');
        }
    };
}
