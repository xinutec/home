import { Routes } from '@angular/router';
import { EnvironmentPage } from './features/environment/environment';
import { House } from './features/house/house';
import { UsagePage } from './features/usage/usage';

export const routes: Routes = [
	{ path: '', pathMatch: 'full', redirectTo: 'environment' },
	// Peer main screens the view menu switches between, none above another.
	{
		path: 'environment',
		title: 'Home · environment',
		component: EnvironmentPage,
		data: { top: true },
	},
	{ path: 'claude', title: 'Home · Claude usage', component: UsagePage, data: { top: true } },
	{ path: 'house', title: 'Home · house', component: House, data: { top: true } },
	{ path: '**', redirectTo: 'environment' },
];
