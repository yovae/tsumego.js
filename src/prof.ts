module tsumego.profile {
    'use strict';

    export const enabled = true;

    export const now = () => performance.now();

    export let started: number;

    export const counters: { [name: string]: number } = {};

    export function reset() {
        for (let name in counters)
            counters[name] = 0;
        started = now();
    }

    export function log() {
        const total = now() - started;
        console.log(`Total: ${(total / 1000).toFixed(2) }s`);
        for (let name in counters)
            console.log(`${name}: ${(counters[name] / total) * 100 | 0}%`);
    }

    export function time(prototype: Object, method: string, d: TypedPropertyDescriptor<Function>) {
        if (!enabled) return;

        const name = prototype.constructor.name + '::' + method;
        const fn = d.value;

        counters[name] = 0;

        d.value = function () {
            const started = now();

            try {
                return fn.apply(this, arguments);
            } finally {
                counters[name] += now() - started;
            }
        };
    }
}
