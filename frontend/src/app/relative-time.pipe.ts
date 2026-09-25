import { Pipe, type PipeTransform } from '@angular/core';

/**
 * "3 min ago". Pass a ticking `now`: a pure pipe re-runs only when an argument
 * changes, so without it the label freezes and a quiet sensor looks fresh.
 */
@Pipe({ name: 'relativeTime' })
export class RelativeTimePipe implements PipeTransform {
	transform(iso: string | null | undefined, now: number): string {
		if (!iso) {
			return 'never';
		}
		const then = new Date(iso).getTime();
		if (Number.isNaN(then)) {
			return 'unknown';
		}
		const seconds = Math.round((now - then) / 1000);
		if (seconds < 5) {
			return 'just now';
		}
		if (seconds < 60) {
			return `${seconds} s ago`;
		}
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) {
			return `${minutes} min ago`;
		}
		const hours = Math.round(minutes / 60);
		if (hours < 24) {
			return `${hours} h ago`;
		}
		const days = Math.round(hours / 24);
		return `${days} d ago`;
	}
}
