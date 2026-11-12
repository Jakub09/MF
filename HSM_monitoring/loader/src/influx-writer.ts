/** Zapis line protocol do InfluxDB 1.x (POST /write, paczkami) */

export interface InfluxTarget {
    url: string;
    database: string;
    username?: string;
    password?: string;
    retentionPolicy?: string;
}

export class WriteError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'WriteError';
    }
}

export async function writeLines(target: InfluxTarget, lines: string[], batchSize = 5000): Promise<void> {
    const params = new URLSearchParams({ db: target.database, precision: 'ns' });
    if (target.retentionPolicy) params.set('rp', target.retentionPolicy);
    const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (target.username) {
        headers.Authorization = `Basic ${Buffer.from(`${target.username}:${target.password ?? ''}`).toString('base64')}`;
    }
    const url = `${target.url.replace(/\/+$/, '')}/write?${params}`;

    for (let i = 0; i < lines.length; i += batchSize) {
        let response: Response;
        try {
            response = await fetch(url, { method: 'POST', headers, body: lines.slice(i, i + batchSize).join('\n') });
        } catch (err) {
            throw new WriteError(`InfluxDB ${target.url}: brak polaczenia (${(err as Error).message})`, { cause: err });
        }
        if (response.status !== 204) {
            throw new WriteError(`InfluxDB /write (baza ${target.database}, punkty ${i + 1}-${Math.min(i + batchSize, lines.length)}): `
                + `HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
        }
    }
}
