package org.xinutec.home

import org.xinutec.shell.ShellConfig
import org.xinutec.shell.WebShellActivity

/** The dashboard at [HOME_URL] in the fleet's shared [WebShellActivity]. */
class MainActivity : WebShellActivity() {
    override val shell =
        ShellConfig(
            url = HOME_URL,
            // The app itself plus the Nextcloud sign-in hop, so the session lands in
            // the app (the house view sends its slow frames only when signed in);
            // everything else goes to the real browser.
            allowedHosts = setOf("home.xinutec.org", NC_HOST),
        )

    private companion object {
        const val HOME_URL = "https://home.xinutec.org/"
        const val NC_HOST = "dash.xinutec.org"
    }
}
