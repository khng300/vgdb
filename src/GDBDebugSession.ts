import { DebugProtocol } from 'vscode-debugprotocol';
import {
    InitializedEvent,
	LoggingDebugSession,
    TerminatedEvent,
    StoppedEvent,
    StackFrame,
    Thread,
    Scope,
    ContinuedEvent,
    OutputEvent,
    Variable
} from 'vscode-debugadapter';
import { GDB, EVENT_BREAKPOINT_HIT, EVENT_END_STEPPING_RANGE, EVENT_RUNNING,
         EVENT_EXITED_NORMALLY, EVENT_FUNCTION_FINISHED, EVENT_OUTPUT,
         EVENT_SIGNAL, SCOPE_LOCAL, EVENT_PAUSED, EVENT_ERROR,
         EVENT_ERROR_FATAL } from './GDB';
import { Record } from "./parser/Record";
import * as vscode from "vscode";
import { OutputChannel } from 'vscode';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** Absolute program to path to debug */
	program: string;
	/** Should inferior immediately stop? */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
    trace?: boolean;
    /** Arguments to pass to inferior */
    args?: [];
    /** Launch directory */
    cwd: string;
    /** Debugger path */
    debugger: string;
    /** Target name */
    name: string;
}

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	/** PID of process to debug. */
    program: number;
    /** Debugger path */
    debugger: string;
}

export class GDBDebugSession extends LoggingDebugSession {
    private GDB: GDB;
    private outputChannel: OutputChannel;
    private debug: boolean;
    private attach: boolean = false;

    public constructor() {
        super();
        this.debug = true;

        // The outputChannel is to separate debug logging from the adapter
        // from the output of GDB. We need to clear it on each launch
        // request to remove stale output from prior runs
        this.outputChannel = vscode.window.createOutputChannel("vGDB");
        this.outputChannel.clear();

        this.GDB = new GDB(this.outputChannel);
    }

    protected log(text: string) : void {
        if (this.debug) {
            this.outputChannel.appendLine(text);
        }
    }

    protected error(text: string) : void {
        console.error(text);
        vscode.window.showErrorMessage(text);
    }

    protected async initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments): Promise<void> {
            // Bind error handler for unexpected GDB errors
            this.GDB.on(EVENT_ERROR_FATAL, (tid: number) => {
                this.error("vGDB has encountered a fatal error. Please report this error at http://www.github.com/penagos/vgdb/issues");
                this.sendEvent(new TerminatedEvent());
            });

            // Pipe to debug console
            this.GDB.on(EVENT_OUTPUT, (text: string) => {
                // Massage GDB output as much as possible
                text = text.replace(/^~"[0-9]*/g, '')
                           .replace(/&"/g, '')
                           .replace(/"$/g, '')
                           .replace(/"$/g, '')
                           .replace(/\\n/g, '')
                           .replace(/\\r/g, '')
                           .replace(/\\t/g, '\t')
                           .replace(/\\v/g, '\v')
                           .replace(/\\\"/g, '\"')
                           .replace(/\\\'/g, '\'')
                           .replace(/\\\\/g, '\\');
                this.sendEvent(new OutputEvent(text + '\n', 'console'));
            });

            // Events triggered by debuggeer
            this.GDB.on(EVENT_RUNNING, (threadID: number, allThreads: boolean) => {
                this.sendEvent(new ContinuedEvent(threadID, allThreads));
            });

            this.GDB.on(EVENT_BREAKPOINT_HIT, (threadID: number) => {
                this.sendEvent(new StoppedEvent("breakpoint", threadID));
            });

            this.GDB.on(EVENT_END_STEPPING_RANGE, (threadID: number) => {
                this.sendEvent(new StoppedEvent("step", threadID));
            });

            this.GDB.on(EVENT_FUNCTION_FINISHED, (threadID: number) => {
                this.sendEvent(new StoppedEvent("step-out", threadID));
            });

            this.GDB.on(EVENT_EXITED_NORMALLY, () => {
                this.sendEvent(new TerminatedEvent());
            });

            this.GDB.on(EVENT_SIGNAL, (threadID: number) => {
                // TODO: handle other signals
                this.sendEvent(new StoppedEvent('pause', threadID));
            });

            this.GDB.on(EVENT_PAUSED, () => {
                this.sendEvent(new StoppedEvent('pause', 1));
            });

            this.GDB.on(EVENT_ERROR, (msg: string) => {
                vscode.window.showErrorMessage(msg);
            });

            response.body = response.body || {};
            response.body.supportsEvaluateForHovers = true;
            response.body.supportsSetVariable = true;
            response.body.supportsEvaluateForHovers = true;
            response.body.supportsTerminateRequest = true;

            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        }

    protected async attachRequest(response: DebugProtocol.AttachResponse,
        args: AttachRequestArguments) {
            this.attach = true;
            this.GDB.spawn(args.debugger, args.program, undefined).then(() => {
                this.sendResponse(response);
            }, (error) => {
                this.sendErrorResponse(response, 0, error);
                this.sendEvent(new TerminatedEvent());
            });
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse,
        args: LaunchRequestArguments) {
            // Only send initialized response once GDB is fully spawned
            this.GDB.spawn(args.debugger, args.program, args.args).then(() => {
                if (!this.attach) {
                    return this.GDB.startInferior();
                } else {
                    return this.GDB.attachInferior();
                }
            }, (error) => {
                this.sendErrorResponse(response, 0, error);
                this.sendEvent(new TerminatedEvent());
            });
    }

    protected setBreakPointsRequest (
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments): void {
            this.GDB.clearBreakpoints().then(() => {
                // If relative paths are to be used, strip out the CWD from the source path
                /*
                let sourcePath = args.source.path || "";
                sourcePath = sourcePath.replace(this.cwd, "");

                if (sourcePath[0] == '/') {
                    sourcePath = sourcePath.substr(1);
                }
*/

                this.GDB.setBreakpoints(args.source.path || "", args.breakpoints).then(bps => {
                    response.body = {
                        breakpoints: bps
                    };
                    this.sendResponse(response);
                });
            });
        }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        this.GDB.getThreads().then((threads: Thread[]) => {
            response.body = {
                threads: threads
            };
            this.sendResponse(response);
        });
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments): void {
            this.GDB.getStack(args.threadId).then((stack: StackFrame[]) => {
                response.body = {
                    stackFrames: stack,
                    totalFrames: stack.length - 1
                };
                this.sendResponse(response);
            });
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments): void {
            // We will always create the same scopes regardless of the state of the
            // debugger
            response.body = {
                scopes: [
                    new Scope("Local", SCOPE_LOCAL, false)
                ]
            };
            this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments,
        request?: DebugProtocol.Request) {
            // For now we assume all requests are for SCOPE_LOCAL -- will need to
            // be revisited once support for additional scopes is added
            this.GDB.getVars(args.variablesReference).then((vars: any[]) => {
                let variables:Variable[] = [];

                vars.forEach(variable => {
                    variables.push(new Variable(variable.name, variable.value));
                });

                response.body = {
                    variables: variables
                };

                this.sendResponse(response);
            });
    }

    protected nextRequest(response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments): void {

        this.GDB.next(args.threadId).then(() => {
            this.sendResponse(response);
        });
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments): void {

        this.GDB.stepIn(args.threadId).then(() => {
            this.sendResponse(response);
        });
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments): void {

        this.GDB.stepOut(args.threadId).then(() => {
            this.sendResponse(response);
        });
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments): void {

        this.GDB.continue(args.threadId).then(() => {
            this.sendResponse(response);
        });
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments): void {

        // GDB enumerates frames starting at 0
        if (args.frameId) {
            --args.frameId;
        }

        switch (args.context) {
            case "repl":
                // User is requesting evaluation of expr at debug console prompt.
                // We cannot simply send it while the process is running -- we need
                // to trigger an interrupt, issue the command, and continue execution
                if (!this.GDB.isStopped()) {
                    this.GDB.pause().then(() => {
                        this.GDB.execUserCmd(args.expression, args.frameId).then((result: Record) => {

                            // continue execution
                            this.GDB.continue().then(() => {
                                this.sendResponse(response);
                            });
                        });
                    });
                } else {
                    this.GDB.execUserCmd(args.expression, args.frameId).then((result: Record) => {
                        this.sendResponse(response);
                    });
                }

            break;

            case "hover":
                // User has hovered over variable
                this.GDB.evaluateExpr(args.expression, args.frameId).then((result: any) => {
					response.body =
					{
						result: result,
						variablesReference: 1
					};
					this.sendResponse(response);
                });
            break;
        }
    }

	protected pauseRequest(response: DebugProtocol.PauseResponse,
		args: DebugProtocol.PauseArguments): void {
            this.GDB.pause().then(() => {
                this.sendResponse(response);
            });
    }

    protected terminateRequest(response: DebugProtocol.TerminateResponse,
        args: DebugProtocol.TerminateArguments): void {
            this.sendResponse(response);
    }
}