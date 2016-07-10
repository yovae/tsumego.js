module testbench {
    function hookToolToKey(tool: string, key: string) {
        document.addEventListener('keydown', event => {
            if (event.key.toUpperCase() == key.toUpperCase())
                vm.tool = tool;
        });

        document.addEventListener('keyup', event => {
            if (event.key.toUpperCase() == key.toUpperCase())
                vm.tool = '';
        });
    }

    hookToolToKey('MA', 'T'); // T = target
    hookToolToKey('AB', 'B'); // B = black
    hookToolToKey('AW', 'W'); // W = white

    export const vm = {
        /** The currently selected editor tool: MA, AB, AW, etc. */
        get tool(): string {
            const button = document.querySelector('#tool > button.active');
            return button && button.getAttribute('data-value');
        },

        set tool(value: string) {
            for (const button of document.querySelectorAll('#tool > button')) {
                if (button.getAttribute('data-value') == value)
                    button.classList.add('active');
                else
                    button.classList.remove('active');
            }
        },

        /** Tells to invoke the solver in the step-by-step mode. */
        get debugSolver(): boolean {
            return /\bdebug=1\b/.test(location.search);
        },

        /** ko master: +1, -1 or 0 */
        get km(): number {
            const b = document.querySelector('#km > button.active');
            return b && +b.getAttribute('data-value');
        },

        /** e.g. "B3 bc" */
        set coords(text: string) {
            $('#coords')[0].childNodes[1].textContent = text;
        },

        set note(text: string) {
            $('#comment')[0].childNodes[1].textContent = text;
        }
    };
}
