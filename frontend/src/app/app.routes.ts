import { Routes } from '@angular/router';
import { EnvironmentPage } from './features/environment/environment';
import { UsagePage } from './features/usage/usage';

// Two top-level views. Environment (temperature/air) is the default landing
// page; Claude usage lives at its own path, reached from the toolbar menu.
export const routes: Routes = [
	{ path: '', pathMatch: 'full', redirectTo: 'environment' },
	{ path: 'environment', title: 'Home · environment', component: EnvironmentPage },
	{ path: 'claude', title: 'Home · Claude usage', component: UsagePage },
	{ path: '**', redirectTo: 'environment' },
];
