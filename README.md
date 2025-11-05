# SaplingFS
Voxel-based Entropy-oriented Minecraft File System.

In other words: every block in-game is mapped to a file on your computer. Breaking blocks deletes their associated files. See this video for a visual explanation: https://youtu.be/NPvLTFl9o-M

## Usage
> [!WARNING]
> **This program is capable of deleting files and killing other processes.**
> 
> The following guide describes only how to set up a "read-only" instance, which _should_ be safe.

1. Download the latest release binary for your operating system.
   - If you're on **Windows**, you'll want [`SaplingFS-windows.exe`](https://github.com/p2r3/SaplingFS/releases/download/latest/SaplingFS-windows.exe).
     - On certain Windows browsers, the download may be blocked as unsafe. Rest assured that the entire code and build process is public and open-source, so if I _was_ trying to give you a virus, people would've already called me out on that. To dismiss this warning, find the menu containing the "Keep" option.
   - If you're on **Linux**, you'll want [`SaplingFS-linux`](https://github.com/p2r3/SaplingFS/releases/download/latest/SaplingFS-linux).
2. Open a terminal shell.
   - **On Windows**: Go to the folder where you downloaded `SaplingFS-windows.exe`. Hold Shift and right-click anywhere in the folder. You should see an option to open PowerShell - click that.
   - **On Linux**: You probably already know how to open a terminal. In most file browsers, F4 opens one in the current directory. You'll likely have to run `chmod +x SaplingFS-linux` to make the file executable.
3. Create a new Minecraft void world.
   - Any relatively modern Minecraft version should work, though this has been tested most thoroughly on 1.21.10.
   - To create a _void world_, go into the "World" tab, switch "World Type" to "Superflat", click "Customize", click "Presets", and select "The Void".
     - If you want mobs to spawn, you'll have to change the last part of the preset text from `minecraft:the_void` to `minecraft:plains` (or similar).
   - Make sure the game mode is "Creative", or at least ensure that you'll be able to run commands.
   - Give the world a unique (and ideally simple) name. The rest of this guide will use "`saplingfs_world`", so either use the same name or remember to replace it in the commands that follow.
4. Disable random ticks (optional but recommended).
   - Once in-game, use the command `/gamerule randomTickSpeed 0` to disable random block ticks. For an unknown reason, leaves placed by this program decay despite being connected to a log. (Contributions welcome.)
5. Save the world and quit to the title screen.
6. In the terminal window you opened earlier:
   - **On Windows**: type `.\SaplingFS-windows.exe "saplingfs_world"`
   - **On Linux**: type `./SaplingFS-linux "saplingfs_world"`
     - This will begin scanning your filesystem and generating terrain from it. The world you chose will be backed up before the new chunks get injected. Once this process has finished, you should see a message claiming that it's listening for clipboard changes and block changes. **If you see mentions of deleted files**, do not worry. Unless you've explicitly allowed the program to delete files, these messages are purely cosmetic.
     - You can stop the program by pressing `Ctrl + C`. The next time you run this same command, the program will attempt to "continue" where you last left off. If you instead want to generate new terrain, either delete the `mapping` folder beside the program binary, or add `--no-progress` to the end of the command.

For a more succinct usage guide, run the program without any arguments.

## Contributing
Contributions _are_ welcome, but please keep in mind that I don't intend to actively maintain this repository outside of critical bugfixes. As such,
- Expect new features to be merged slowly or not at all.
- This is _not_ a good place to make your first open-source contribution. I tend to be very mean if I feel like someone's wasting my time. So, if you _do_ contribute, please do so meaningfully and with effort. Half-assed QoL commits will not be accepted. I do wish I could be more inclusive of contributions of all sizes, but there simply aren't enough hours in the day for that. Thank you for understanding.
