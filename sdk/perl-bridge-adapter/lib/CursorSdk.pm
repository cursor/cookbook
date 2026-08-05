package CursorSdk;

use strict;
use warnings;
use JSON::PP;
use Exporter qw(import);
our @EXPORT_OK = qw(prompt);

our $VERSION = '0.1.0';

my $READY_PREFIX     = 'cursor-sdk-bridge ready ';
my $STARTUP_TIMEOUT  = 30;
my $SHUTDOWN_TIMEOUT = 5;
my $JSON             = JSON::PP->new->utf8->canonical;

sub prompt {
    my ( $text, %opts ) = @_;
    my $client = CursorSdk::Client->new(%opts);
    my $agent  = $client->create_agent(
        model => $opts{model},
        cwd   => $opts{cwd} // $client->{workspace},
    );
    my $run = $agent->send($text);
    my $result = eval { $run->wait() };
    my $err = $@;
    eval { $agent->close() };
    eval { $client->shutdown() };
    die $err if $err;
    return $result->{text} // $result->{result} // '';
}

package CursorSdk::Error;
use overload '""' => sub { $_[0]->{message} };

sub new {
    my ( $class, $message, %extra ) = @_;
    return bless { message => $message, %extra }, $class;
}

package CursorSdk::Client;

use File::Spec;
use File::Temp qw(tempdir);
use HTTP::Tiny;
use POSIX qw(:sys_wait_h);
use Time::HiRes qw(sleep time);

sub new {
    my ( $class, %opts ) = @_;
    my $self = bless {
        workspace => File::Spec->rel2abs( $opts{workspace} // '.' ),
        api_key   => $opts{api_key} // $ENV{CURSOR_API_KEY},
        binary    => $opts{bridge}
          // $ENV{CURSOR_SDK_BRIDGE_BIN}
          // File::Spec->catfile( '.', 'cursor-sdk-bridge', 'bin',
            $^O eq 'MSWin32' ? 'cursor-sdk-bridge.exe' : 'cursor-sdk-bridge' ),
        pid      => undef,
        endpoint => undef,
        token    => undef,
        http        => HTTP::Tiny->new( timeout => 60 ),
        stream_http => HTTP::Tiny->new( timeout => 600 ),
        errfile  => undef,
    }, $class;
    $self->_start_bridge unless $opts{url};
    if ( $opts{url} ) {
        $self->{endpoint} = $opts{url};
        $self->{token}    = $opts{token}
          or die CursorSdk::Error->new('token is required when attaching to url');
    }
    return $self;
}

sub _start_bridge {
    my ($self) = @_;
    my $dir = tempdir( CLEANUP => 1 );
    $self->{errfile} = File::Spec->catfile( $dir, 'bridge.err.log' );

    my $pid = fork;
    die CursorSdk::Error->new("could not fork: $!") unless defined $pid;
    if ( $pid == 0 ) {
        open STDOUT, '>', File::Spec->devnull;
        open STDERR, '>', $self->{errfile} or die $!;
        my %env = %ENV;
        $env{CURSOR_SDK_CLIENT_LANGUAGE} = 'perl';
        $env{CURSOR_API_KEY} = $self->{api_key} if defined $self->{api_key};
        local %ENV = %env;
        exec { $self->{binary} } $self->{binary}, '--workspace', $self->{workspace}
          or exit 127;
    }
    $self->{pid} = $pid;

    my $deadline = time + $STARTUP_TIMEOUT;
    my $discovery;
    while ( time < $deadline ) {
        if ( waitpid( $pid, WNOHANG ) == $pid ) {
            my $diag = _slurp( $self->{errfile} );
            die CursorSdk::Error->new(
                "bridge exited before ready line:\n$diag");
        }
        my $text = -e $self->{errfile} ? _slurp( $self->{errfile} ) : '';
        for my $line ( split /\n/, $text ) {
            next unless index( $line, $READY_PREFIX ) == 0;
            my $json = substr( $line, length($READY_PREFIX) );
            $discovery = eval { $JSON->decode($json) };
            die CursorSdk::Error->new("invalid discovery JSON: $@") if $@;
            last;
        }
        last if $discovery;
        sleep 0.05;
    }
    unless ($discovery) {
        $self->_kill_bridge;
        die CursorSdk::Error->new(
            "timed out after ${STARTUP_TIMEOUT}s waiting for bridge ready line");
    }
    if (  ( $discovery->{schemaVersion} // 0 ) != 1
        || ( $discovery->{transport}     // '' ) ne 'tcp'
        || ( $discovery->{protocol}      // '' ) ne 'connect' )
    {
        $self->_kill_bridge;
        die CursorSdk::Error->new('unsupported bridge discovery payload');
    }

    my $token_file = $discovery->{authTokenFile}
      or die CursorSdk::Error->new('discovery omitted authTokenFile');
    my $token = _slurp($token_file);
    $token =~ s/\s+\z//;
    $token =~ s/\A\s+//;
    die CursorSdk::Error->new("empty auth token in $token_file") unless length $token;

    $self->{endpoint} = $discovery->{url};
    $self->{token}    = $token;
    return;
}

sub ping {
    my ($self) = @_;
    return $self->_unary( 'SdkBridgeControlService', 'Ping', {} );
}

sub version {
    my ($self) = @_;
    return $self->_unary( 'SdkBridgeControlService', 'GetVersion', {} );
}

sub models {
    my ($self) = @_;
    my $res = $self->_unary(
        'SdkCursorService',
        'ListModels',
        { options => { apiKey => $self->_require_key } },
    );
    return $res->{items} // [];
}

sub create_agent {
    my ( $self, %opts ) = @_;
    my $model = $opts{model};
    unless ($model) {
        my $models = $self->models;
        die CursorSdk::Error->new('no models available to this account')
          unless @$models;
        $model = $models->[0]{id};
    }
    my $cwd = File::Spec->rel2abs( $opts{cwd} // $self->{workspace} );
    my $res = $self->_unary(
        'SdkAgentService',
        'CreateAgent',
        {
            options => {
                model  => { id => $model },
                apiKey => $self->_require_key,
                local  => { cwd => [$cwd] },
            },
        },
    );
    return CursorSdk::Agent->new(
        client   => $self,
        agent_id => $res->{agentId},
        model    => ( $res->{model} && $res->{model}{id} ) || $model,
    );
}

sub shutdown {
    my ($self) = @_;
    if ( $self->{endpoint} && $self->{token} ) {
        eval {
            $self->_unary( 'SdkBridgeControlService', 'Shutdown',
                { graceSeconds => 0 } );
        };
    }
    $self->_kill_bridge;
    return;
}

sub DESTROY {
    my ($self) = @_;
    eval { $self->shutdown };
}

sub _require_key {
    my ($self) = @_;
    return $self->{api_key}
      if defined $self->{api_key} && length $self->{api_key};
    die CursorSdk::Error->new(
        'CURSOR_API_KEY is required (https://cursor.com/dashboard)');
}

sub _unary {
    my ( $self, $service, $method, $payload ) = @_;
    my $url = $self->{endpoint} . "/sdk.v1.$service/$method";
    my $res = $self->{http}->request(
        'POST', $url,
        {
            headers => {
                'content-type'            => 'application/json',
                authorization             => "Bearer $self->{token}",
                'connect-protocol-version' => '1',
            },
            content => $JSON->encode( $payload // {} ),
        },
    );
    my $body = $res->{content} // '';
    unless ( $res->{success} ) {
        die CursorSdk::Error->new( _connect_error($body, $res->{status}) );
    }
    return length($body) ? $JSON->decode($body) : {};
}

sub _stream {
    my ( $self, $service, $method, $payload, $on_message ) = @_;
    my $json   = $JSON->encode( $payload // {} );
    my $framed = pack( 'C N', 0, length($json) ) . $json;
    my $url    = $self->{endpoint} . "/sdk.v1.$service/$method";
    my $buf    = '';
    my $done   = 0;
    my $res    = $self->{stream_http}->request(
        'POST', $url,
        {
            headers => {
                'content-type'             => 'application/connect+json',
                authorization              => "Bearer $self->{token}",
                'connect-protocol-version' => '1',
            },
            content       => $framed,
            data_callback => sub {
                my ($chunk) = @_;
                return if $done;
                $buf .= $chunk;
                while (1) {
                    last if length($buf) < 5;
                    my ( $flags, $len ) = unpack( 'C N', substr( $buf, 0, 5 ) );
                    last if length($buf) < 5 + $len;
                    substr $buf, 0, 5, '';
                    my $frame = substr $buf, 0, $len, '';
                    if ( $flags & 0x02 ) {
                        if ( length $frame ) {
                            my $end = eval { $JSON->decode($frame) } || {};
                            if ( $end->{error} ) {
                                die CursorSdk::Error->new(
                                    _connect_error(
                                        $JSON->encode( $end->{error} )
                                    )
                                );
                            }
                        }
                        $done = 1;
                        return;
                    }
                    next unless length $frame;
                    my $msg = eval { $JSON->decode($frame) };
                    next if $@ || ref($msg) ne 'HASH';
                    next unless keys %$msg;
                    $on_message->($msg);
                }
            },
        },
    );
    unless ( $res->{success} ) {
        die CursorSdk::Error->new(
            _connect_error( $res->{content}, $res->{status} ) );
    }
    return;
}

sub _kill_bridge {
    my ($self) = @_;
    my $pid = delete $self->{pid};
    return unless $pid;
    kill 'TERM', $pid;
    my $deadline = time + $SHUTDOWN_TIMEOUT;
    while ( time < $deadline ) {
        return if waitpid( $pid, WNOHANG ) == $pid;
        sleep 0.05;
    }
    kill 'KILL', $pid;
    waitpid( $pid, 0 );
    return;
}

sub _slurp {
    my ($path) = @_;
    open my $fh, '<', $path or return '';
    local $/;
    return scalar <$fh>;
}

sub _connect_error {
    my ( $body, $status ) = @_;
    my $decoded = eval { $JSON->decode( $body // '' ) };
    if ( ref($decoded) eq 'HASH' ) {
        my $code    = $decoded->{code}    // '';
        my $message = $decoded->{message} // 'request failed';
        return $status ? "$code $message (HTTP $status)" : "$code $message";
    }
    return $status ? "HTTP $status: $body" : ( $body || 'request failed' );
}

package CursorSdk::Agent;

sub new {
    my ( $class, %opts ) = @_;
    return bless {%opts}, $class;
}

sub id    { $_[0]{agent_id} }
sub model { $_[0]{model} }

sub send {
    my ( $self, $text ) = @_;
    return CursorSdk::Run->new(
        client   => $self->{client},
        agent_id => $self->{agent_id},
        text     => $text,
    );
}

sub close {
    my ($self) = @_;
    $self->{client}->_unary(
        'SdkAgentService',
        'CloseAgent',
        { agentId => $self->{agent_id} },
    );
    return;
}

package CursorSdk::Run;

sub new {
    my ( $class, %opts ) = @_;
    my $self = bless {
        %opts,
        events       => [],
        result       => undef,
        text_pieces  => [],
        error_status => undef,
        started      => 0,
    }, $class;
    return $self;
}

sub _ensure_started {
    my ($self) = @_;
    return if $self->{started}++;
    $self->{client}->_stream(
        'SdkAgentService',
        'Send',
        {
            agentId => $self->{agent_id},
            message => { text => $self->{text} },
        },
        sub { $self->_on_envelope( $_[0] ) },
    );
    return;
}

sub events {
    my ($self) = @_;
    $self->_ensure_started;
    return @{ $self->{events} };
}

sub iter_text {
    my ($self) = @_;
    $self->_ensure_started;
    return @{ $self->{text_pieces} };
}

sub wait {
    my ($self) = @_;
    $self->_ensure_started;
    if ( $self->{result} ) {
        return $self->_result_hash;
    }
    if ( $self->{run_id} ) {
        my $res = $self->{client}->_unary(
            'SdkAgentService',
            'WaitLiveRun',
            { runId => $self->{run_id} },
        );
        $self->{result} = $res->{result} if $res->{result};
    }
    return $self->_result_hash;
}

sub _result_hash {
    my ($self) = @_;
    my $result = $self->{result} // {};
    my $status = $result->{status} // '';
    $status =~ s/^RUN_LIFECYCLE_STATUS_//;
    $status = lc $status;
    return {
        status        => $status || 'unknown',
        ok            => ( $status eq 'finished' ),
        text          => $result->{result},
        result        => $result->{result},
        duration_ms   => $result->{durationMs},
        run_id        => $result->{runId} // $self->{run_id},
        error_message => $self->{error_status},
    };
}

sub _on_envelope {
    my ( $self, $msg ) = @_;
    if ( $msg->{sdkMessage} ) {
        my $type    = $msg->{sdkMessage}{type}    // '';
        my $payload = $msg->{sdkMessage}{message} // {};
        push @{ $self->{events} }, { type => $type, payload => $payload };
        $self->{run_id} ||= $payload->{run_id} || $payload->{runId};
        if ( $type eq 'assistant' ) {
            my $blocks = $payload->{message}{content} // [];
            for my $block (@$blocks) {
                next unless ref($block) eq 'HASH' && ( $block->{type} // '' ) eq 'text';
                push @{ $self->{text_pieces} }, $block->{text} if defined $block->{text};
            }
        }
        if ( $type eq 'status' && ( $payload->{message} // '' ) ne '' ) {
            $self->{error_status} = $payload->{message};
        }
        return;
    }
    if ( $msg->{result} ) {
        $self->{result} = $msg->{result}{result} // $msg->{result};
        $self->{run_id} ||= $msg->{result}{runId};
        return;
    }
    return;
}

1;
