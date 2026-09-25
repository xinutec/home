package org.xinutec.home

import org.xinutec.shell.ShellConfig
import org.xinutec.shell.WebShellActivity

/** The dashboard at [HOME_URL] in the fleet's shared [WebShellActivity]. */
class MainActivity : WebShellActivity() {
    override val shell = ShellConfig(url = HOME_URL)

    private companion object {
        const val HOME_URL = "https://home.xinutec.org/"
    }
}
