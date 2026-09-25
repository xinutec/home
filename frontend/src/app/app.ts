import { Component, type OnDestroy, type OnInit, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from './api.service';
import { SwUpdates } from './sw-updates';
import { Telemetry } from './telemetry';
import { ThemeService } from './theme.service';

/** One entry in the view menu. */
interface NavItem {
	path: string;
	label: string;
	icon: string;
}

/**
 * App shell. Starts the data polling, telemetry and self-update once, here, so
 * no page has to and switching pages restarts nothing.
 */
@Component({
	selector: 'app-root',
	imports: [
		MatToolbarModule,
		MatButtonModule,
		MatIconModule,
		MatMenuModule,
		MatTooltipModule,
		RouterOutlet,
		RouterLink,
		RouterLinkActive,
	],
	templateUrl: './app.html',
	styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
	private readonly api = inject(ApiService);
	protected readonly theme = inject(ThemeService);
	private readonly telemetry = inject(Telemetry);
	private readonly swUpdates = inject(SwUpdates);

	protected readonly nav: readonly NavItem[] = [
		{ path: '/environment', label: 'Environment', icon: 'thermostat' },
		{ path: '/claude', label: 'Claude usage', icon: 'smart_toy' },
	];

	protected readonly themeIcon = computed(() => {
		switch (this.theme.mode()) {
			case 'light':
				return 'light_mode';
			case 'dark':
				return 'dark_mode';
			default:
				return 'brightness_auto';
		}
	});

	protected readonly themeLabel = computed(() => `Theme: ${this.theme.mode()}`);

	ngOnInit(): void {
		this.telemetry.init();
		this.swUpdates.start();
		this.api.start();
	}

	ngOnDestroy(): void {
		this.api.stop();
	}

	protected toggleTheme(): void {
		this.theme.toggle();
	}
}
