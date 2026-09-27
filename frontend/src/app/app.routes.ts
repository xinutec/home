import { Routes } from '@angular/router';
import { EnvironmentPage } from './features/environment/environment';
import { UsagePage } from './features/usage/usage';

export const routes: Routes = [
	{ path: '', pathMatch: 'full', redirectTo: 'environment' },
	// Two peer main screens the view menu switches between, neither above the other.
	{
		path: 'environment',
		title: 'Home · environment',
		component: EnvironmentPage,
		data: { top: true },
	},
	{ path: 'claude', title: 'Home · Claude usage', component: UsagePage, data: { top: true } },
	{ path: '**', redirectTo: 'environment' },
];
