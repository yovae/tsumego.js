module tsumego.mgen {
    export interface Generator {
        (color: number): stone[];
    }

    export function eulern(board: Board, color: number, q: number = 2) {
        let n1 = 0, n2 = 0, n3 = 0;

        for (let x = -1; x <= board.size; x++) {
            for (let y = -1; y <= board.size; y++) {
                const a = +((board.get(x, y) * color) > 0);
                const b = +((board.get(x + 1, y) * color) > 0);
                const c = +((board.get(x + 1, y + 1) * color) > 0);
                const d = +((board.get(x, y + 1) * color) > 0);

                switch (a + b + c + d) {
                    case 1: n1++; break;
                    case 2: if (a == c) n2++; break;
                    case 3: n3++; break;
                }
            }
        }

        return (n1 - n3 + q * n2) / 4;
    }
}

