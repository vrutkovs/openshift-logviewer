#!/usr/bin/env node
const express = require("express");
const bodyParser = require("body-parser");
const serveStatic = require("serve-static");
const slashes = require("connect-slashes");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
const database = require("database");

const app = express();
app.enable("strict routing");
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");
app.set("trust proxy", "loopback, linklocal, uniquelocal");
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":response-time ms" ":referrer" ":user-agent"'));

const RESOURCES_ROOT = process.env.DIGDOWN_RESOURCES_ROOT;
if (typeof RESOURCES_ROOT === "undefined" || RESOURCES_ROOT === "") {
    console.error("The environment variable DIGDOWN_RESOURCES_ROOT should be set and point to a directory with resources.");
    process.exit(1);
}

const APP_ROOT = process.env.DIGDOWN_APP_ROOT || "";
const GA_TRACKING_ID = process.env.DIGDOWN_GA_TRACKING_ID || "";

function mkdirP(p, callback) {
    const mode = 0777 & (~process.umask());
    p = path.resolve(p);
    fs.mkdir(p, mode, (err) => {
        if (!err) {
            return callback(null);
        }
        switch (err.code) {
        case 'ENOENT':
            mkdirP(path.dirname(p), (err) => {
                if (err) {
                    callback(err);
                    return;
                }
                mkdirP(p, callback);
            });
            break;
        default:
            fs.stat(p, function(e, stat) {
                if (e || !stat.isDirectory()) {
                    callback(err);
                } else {
                    callback(null);
                }
            });
        }
    });
}

function safePath(s) {
    return /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/.test(s);
}

function resourceStat(namespace, name, callback) {
    fs.stat(RESOURCES_ROOT + "/" + namespace + "/" + name, callback);
}

function resourceRead(namespace, name, callback) {
    fs.readFile(RESOURCES_ROOT + "/" + namespace + "/" + name, callback);
}

function resourceWrite(namespace, name, value, callback) {
    mkdirP(RESOURCES_ROOT + "/" + namespace, (err) => {
        if (err) {
            callback(err);
            return;
        }
        fs.writeFile(RESOURCES_ROOT + "/" + namespace + "/" + name, value, callback);
    });
}

function readSegments(namespace, callback) {
    resourceRead(namespace, "segments.json", (err, data) => {
        if (err) {
            if (err.code !== "ENOENT") {
                callback(err, data);
                return;
            }
            child_process.execFile("make", ["jobs/" + namespace + "/segments.json"], {
                cwd: RESOURCES_ROOT + "/../",
            }, (err, stdout, stderr) => {
                if (err) {
                    callback(err);
                    return;
                }
                readSegments(namespace, callback);
            });
            return;
        }
        callback(err, data);
    });
}

function getPermanentURL(url) {
    let match = /^https?:\/\/openshift-gce-devel\.appspot\.com\/+build\/+origin-ci-test\/+pr-logs\/+pull\/+([A-Za-z0-9\/_-]+)\/+([A-Za-z0-9_-]+\/+[0-9]+)\/*(\?[A-Za-z0-9=%&._-]*)?(#.*)?$/.exec(url);
    if (match !== null) {
        let pr = match[1];
        let id = match[2].replace(/\/\/+/g, "/");
        return `https://storage.googleapis.com/origin-ci-test/pr-logs/pull/${pr}/${id}/build-log.txt`;
    }
    match = /^https?:\/\/ci\.openshift\.redhat\.com\/+jenkins\/+job\/+([A-Za-z0-9_-]+\/+[0-9]+)(\/+[A-Za-z0-9\/=%._-]*)?(#.*)?$/.exec(url);
    if (match !== null) {
        let id = match[1].replace(/\/\/+/g, "/");
        return `https://ci.openshift.redhat.com/jenkins/job/${id}/consoleText`;
    }
    match = /^https?:\/\/travis-ci\.org\/+[A-Za-z0-9_-]+\/+[A-Za-z0-9_-]+\/+builds\/+([0-9]+)(\?[A-Za-z0-9=%&._-]*)?(#.*)?$/.exec(url);
    if (match !== null) {
        let build = parseInt(match[1], 10) + 1;
        return `https://api.travis-ci.org/v3/job/${build}/log.txt`;
    }
}

function getID(permanentURL) {
    let match = /^https:\/\/storage.googleapis.com\/origin-ci-test\/pr-logs\/pull\/[A-Za-z0-9\/_-]+\/([A-Za-z0-9_-]+\/[0-9]+)\/build-log\.txt$/.exec(permanentURL);
    if (match !== null) {
        return match[1];
    }
    match = /^https:\/\/ci\.openshift\.redhat\.com\/jenkins\/job\/([A-Za-z0-9_-]+\/[0-9]+)\/consoleText$/.exec(permanentURL);
    if (match !== null) {
        return match[1];
    }
    match = /^https:\/\/api\.travis-ci\.org\/v3\/job\/([0-9]+)\/log\.txt$/.exec(permanentURL);
    if (match !== null) {
        return "travis-ci-org/" + match[1];
    }
}

function serveHomePage(req, res) {
    res.render("home", {
        APP_ROOT: APP_ROOT,
        GA_TRACKING_ID: GA_TRACKING_ID,
    });
}

function serveGoToURL(req, res) {
    let permanentURL = getPermanentURL(req.body.url);
    if (typeof permanentURL === "undefined") {
        res.status(400).type("text/plain").send("Sorry, but the entered URL doesn't match to any known patterns.\n");
        return;
    }
    let id = getID(permanentURL);
    if (typeof id === "undefined") {
        res.status(500).type("text/plain").send("I failed to extract BUILD_NAME/BUILD_NUMBER from this URL. It's a bug.\n");
        return;
    }
    resourceStat(id, "info.json", (err) => {
        if (err) {
            if (err.code !== "ENOENT") {
                console.log("read info.json for", id, err);
                res.status(500).type("text/plain").send("Whoops, something went wrong.\n");
                return;
            }
            resourceWrite(id, "info.json", JSON.stringify({id: id, job_url: permanentURL}), (err) => {
                if (err) {
                    console.log("write info.json for", id, err);
                    res.status(500).type("text/plain").send("I cannot save your URL. :-(\n");
                    return;
                }
                res.redirect(303, `${APP_ROOT}/${id}/`);
            });
            return;
        }
        res.redirect(303, `${APP_ROOT}/${id}/`);
    });
}

function serveIndexPage(namespace, req, res) {
    readSegments(namespace, (err, data) => {
        if (err) {
            console.log("read segments", err);
            res.status(500).type("text/plain").send("I'm not able to process your request. :-(\n");
            return;
        }
        res.render("log", {
            APP_ROOT: APP_ROOT,
            GA_TRACKING_ID: GA_TRACKING_ID,
            namespace: namespace,
            data: data,
        });
    });
}

function serveSimilarPage(namespace, req, res) {
    readSegments(namespace, (err, data) => {
        if (err) {
            console.log("read segments", err);
            res.status(500).type("text/plain").send("I'm not able to process your request. :-(\n");
            return;
        }
        res.render("similar", {
            APP_ROOT: APP_ROOT,
            GA_TRACKING_ID: GA_TRACKING_ID,
            namespace: namespace,
            segment: req.query.segment || "",
        });
    });
}

function serveRaw(namespace, req, res) {
    res.sendFile(namespace + "/raw", {
        root: RESOURCES_ROOT,
    });
}

app.use("/-/assets", serveStatic(path.join(__dirname, "assets")));

app.get("/", function(req, res) {
    serveHomePage(req, res);
});

app.get("/-/info", function(req, res) {
    const namespace = req.query.namespace;
     if (!safePath(namespace)) {
        res.status(400).type("text/plain").send("Unexpected value for the namespace parameter\n");
        return;
    }

    const id = req.query.segment;
    if (!/^[0-9]+(:[0-9]+)*$/.test(id)) {
        res.status(400).type("text/plain").send("Unexpected value for the segment parameter\n");
        return;
    }
    const ids = id.split(":").map(x => parseInt(x, 10));

    readSegments(namespace, (err, data) => {
        if (err) {
            console.log("read segments", err);
            res.status(500).type("text/plain").send("I'm not able to process your request. :-(\n");
            return;
        }
        let base = 0;
        const seg = ids.reduce((seg, offset) => {
            base += offset;
            if (seg === null || typeof seg.segments === "undefined") return null;
            let child = seg.segments.filter(x => x.offset === offset);
            if (child.length !== 1) return null;
            return child[0];
        }, JSON.parse(data));
        if (!seg.metadata || seg.metadata.status !== "failure") {
            res.json({
                similar: [],
            });
            return;
        }
        let name = seg.metadata.name || id;

        database.buildTrigrams(RESOURCES_ROOT + "/" + namespace + "/raw", base, seg.length, (err, trigrams) => {
            if (err) {
                console.log("generate trigrams", err);
                res.status(500).type("text/plain").send("I'm not able to process your request. :-(\n");
                return;
            }
            //database.storeTrigrams(db, namespace, id, name, trigrams, (err) => {
                if (err) {
                    console.log("store trigrams", err);
                    res.status(500).type("text/plain").send("I'm not able to process your request. :-(\n");
                    return;
                }
                database.findSimilarTrigrams(db, trigrams, (err, sim) => {
                    if (err) {
                        console.log("find similar", err);
                        res.status(500).type("text/plain").send("I'm not able to process your request. :-(\n");
                        return;
                    }
                    res.json({
                        similar: sim,
                    });
                });
            //});
        });
    });
});

app.post("/-/go-to-url", function(req, res) {
    serveGoToURL(req, res);
});

app.get("/favicon.ico", function(req, res) {
    res.status(404).type("text/plain").send("404 not found\n");
});

app.get("*", function(req, res) {
    let path = req.path.replace(/^\/+/, "").replace(/\/+/, "/");
    if (!path.endsWith("/")) {
        res.redirect(307, `${APP_ROOT}/${path}/`);
        return;
    }
    path = path.replace(/\/$/, "");
    if (!safePath(path)) {
        res.status(404).type("text/plain").send("404 not found\n");
        return;
    }
    let resource = (typeof req.query.resource !== "undefined" ? req.query.resource : "");
    if (resource === "") {
        serveIndexPage(path, req, res);
    } else if (resource === "raw") {
        serveRaw(path, req, res);
    } else if (resource === "similar") {
        serveSimilarPage(path, req, res);
    } else {
        res.status(400).type("text/plain").send("400 unknown resource\n");
        return;
    }
});

let db;
database.init(RESOURCES_ROOT + "/trigrams.db", (err, d) => {
    if (err) {
        throw err;
    }
    db = d;
    app.listen(8080, function () {
      console.log("Viewer is listening on http://localhost:8080/")
    })
});
