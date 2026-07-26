import { Component, type OnDestroy, type OnInit, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from './api.service';
import { ThemeService } from './theme.service';

/** One entry in the view menu. */
interface NavItem {
	path: string;
	label: string;
	icon: string;
}

/**
 * App shell: the toolbar (brand, view menu, theme toggle) and the router outlet.
 * The data layer is polled here — once for the app's lifetime — so switching
 * routes doesn't restart it and both pages read the same warm signals.
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
		this.api.start();
	}

	ngOnDestroy(): void {
		this.api.stop();
	}

	protected toggleTheme(): void {
		this.theme.toggle();
	}
}
