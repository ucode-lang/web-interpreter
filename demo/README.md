# ucode demo filesystem

This is a small, self-contained file tree loaded into the ucode web
interpreter's virtual (in-memory) filesystem at startup. Everything here
lives in Emscripten's MEMFS -- nothing is read from or written to your
real disk.

## Files

- `/demo/hello.txt`    a plain text file (read with fs.readfile)
- `/demo/notes.uc`     a runnable ucode script (fs + string demo)
- `/demo/data/people.json`   sample JSON to parse
- `/demo/data/numbers.txt`   one number per line, for a read loop
- `/demo/README.md`    this file

## Try these in the REPL

    let fs = require("fs");
    print(fs.readfile("/demo/hello.txt"));
    print(fs.lsdir("/demo"));
    print(fs.stat("/demo/data/people.json").size);

    // NB: print() does not add a trailing newline -- append "\n" to see lines
    let people = json(fs.readfile("/demo/data/people.json"));
    for (let i = 0; i < length(people); i = i + 1)
        print(people[i].name, people[i].age, "\n");

    // read a text file line by line
    let fp = fs.open("/demo/data/numbers.txt", "r");
    let total = 0;
    let line = fp.read("line");
    while (length(line) > 0) {
        total = total + int(line);
        line = fp.read("line");
    }
    fp.close();
    print("sum of numbers:", total, "\n");

    // run the bundled script
    print(fs.readfile("/demo/notes.uc"));
