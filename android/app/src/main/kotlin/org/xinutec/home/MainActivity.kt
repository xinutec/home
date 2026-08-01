package org.xinutec.home

import org.xinutec.shell.ShellConfig
import org.xinutec.shell.WebShellActivity

/**
 * The home environment dashboard — the Angular app served at [HOME_URL], in the
 * fleet's shared [WebShellActivity]. No address bar, no tabs, a home-screen icon:
 * the public dashboard presented as an app, avoiding browser chrome.
 *
 * The whole app, and the reference the shell was measured against: everything a
 * wrapper does is the shell's, so what's left is which page to open.
 */
class MainActivity : WebShellActivity() {
    override val shell = ShellConfig(url = HOME_URL)

    private companion object {
        // The public household-environment dashboard (HTTPS, no auth for reads).
        const val HOME_URL = "https://home.xinutec.org/"
    }
}
